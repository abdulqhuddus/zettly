// Admin API: session-protected endpoints for staff to view and manage
// bookings (list/filter, view detail, change status). Auth lives in
// src/auth.js; this file only assumes a valid session has already been
// checked by the caller (see the /api/admin/* dispatch in src/index.js),
// except for the login/logout/me endpoints themselves.

import {
  verifyPassword,
  createSessionToken,
  buildSessionCookie,
  getSession,
  clientIp,
  isLockedOut,
  recordFailedLogin,
  clearFailedLogins,
} from "./auth.js";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

// A cross-site <form> or <img>/fetch("no-cors") cannot set a custom header,
// so requiring this one on every state-changing admin call is a second,
// independent layer of CSRF defense on top of the SameSite=Strict cookie.
function hasAdminHeader(request) {
  return request.headers.get("X-Admin-Request") === "1";
}

export async function handleAdminLogin(request, env) {
  const ip = clientIp(request);
  if (await isLockedOut(env, ip)) {
    return json({ error: "Too many attempts. Try again later." }, 429);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }

  if (!env.ADMIN_PASSWORD_HASH || !env.SESSION_SECRET) {
    return json({ error: "Admin login is not configured yet" }, 503);
  }

  const ok = await verifyPassword(body?.password, env.ADMIN_PASSWORD_HASH);
  if (!ok) {
    await recordFailedLogin(env, ip);
    return json({ error: "Incorrect password" }, 401);
  }

  await clearFailedLogins(env, ip);
  const token = await createSessionToken(env.SESSION_SECRET, { role: "admin" });
  return json({ ok: true }, 200, { "Set-Cookie": buildSessionCookie(token) });
}

export async function handleAdminLogout() {
  return json({ ok: true }, 200, { "Set-Cookie": buildSessionCookie(null, { clear: true }) });
}

export async function handleAdminMe(request, env) {
  const session = await getSession(request, env);
  return json({ authenticated: !!session });
}

// ---- Booking management (all require an already-verified session) -----

export async function handleAdminListBookings(url, env) {
  const status = url.searchParams.get("status"); // confirmed | cancelled | completed | (empty = all)
  const date = url.searchParams.get("date"); // YYYY-MM-DD
  const from = url.searchParams.get("from"); // YYYY-MM-DD, inclusive
  const to = url.searchParams.get("to"); // YYYY-MM-DD, inclusive
  const q = (url.searchParams.get("q") || "").trim();
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
  const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10) || 0, 0);

  const where = [];
  const params = [];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (date) {
    where.push("date = ?");
    params.push(date);
  }
  if (from) {
    where.push("date >= ?");
    params.push(from);
  }
  if (to) {
    where.push("date <= ?");
    params.push(to);
  }
  if (q) {
    where.push("(customer_name LIKE ? OR customer_email LIKE ? OR id LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const { results } = await env.DB.prepare(
    `SELECT id, service_name, price, duration_minutes, date, time, customer_name, customer_email,
            customer_phone, customer_address, notes, status, created_at
     FROM bookings ${whereSql}
     ORDER BY date DESC, time DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all();

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bookings ${whereSql}`)
    .bind(...params)
    .first();

  const bookings = results.map((r) => ({ ...r, bookingRef: `ZTL-${r.id.split("-")[0].toUpperCase()}` }));
  return json({ bookings, total: totalRow?.n || 0, limit, offset });
}

export async function handleAdminBookingDetail(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, service_id, service_name, price, duration_minutes, date, time, customer_name, customer_email,
            customer_phone, customer_address, notes, status, created_at
     FROM bookings WHERE id = ?`
  )
    .bind(id)
    .first();
  if (!row) return json({ error: "Not found" }, 404);
  return json({ ...row, bookingRef: `ZTL-${row.id.split("-")[0].toUpperCase()}` });
}

const VALID_STATUSES = ["confirmed", "cancelled", "completed"];

export async function handleAdminUpdateStatus(request, env, id) {
  if (!hasAdminHeader(request)) return json({ error: "Bad request" }, 400);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  if (!VALID_STATUSES.includes(body?.status)) {
    return json({ error: "Invalid status" }, 400);
  }
  const existing = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404);

  await env.DB.prepare(`UPDATE bookings SET status = ? WHERE id = ?`).bind(body.status, id).run();

  let emailSent = false;
  if (body.status === "cancelled" && existing.status !== "cancelled" && body.notifyCustomer !== false) {
    emailSent = (await sendCancellationEmail(env, existing)).sent;
  }

  return json({ ok: true, id, status: body.status, emailSent });
}

// A short, plain cancellation notice — deliberately simpler than the
// booking-confirmation email (no logo/attachment needed for a cancellation).
async function sendCancellationEmail(env, booking) {
  if (!env.RESEND_API_KEY) return { sent: false, reason: "no_api_key" };
  const bookingRef = `ZTL-${booking.id.split("-")[0].toUpperCase()}`;
  const from = env.RESEND_FROM || "Zettly <onboarding@resend.dev>";
  const dateDisplay = new Date(booking.date + "T00:00:00").toLocaleDateString("de-DE", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const html = `
  <div style="font-family: 'Segoe UI', Arial, sans-serif; background:#f4f2fa; padding:32px 16px;">
    <div style="max-width:480px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; border:1px solid #e9e7ef;">
      <div style="padding:24px 28px; border-bottom:1px solid #e9e7ef;">
        <div style="font-family:'Helvetica Neue', Arial, sans-serif; font-size:22px; font-weight:300; letter-spacing:0.01em;"><span style="color:#111114;">zett</span><span style="color:#7C3AED;">ly</span></div>
      </div>
      <div style="padding:28px;">
        <p style="margin:0 0 14px; font-size:15px; font-weight:700; color:#111114;">Hallo ${booking.customer_name},</p>
        <p style="margin:0 0 14px; font-size:13.5px; color:#6b6b74; line-height:1.5;">Ihre Buchung <strong>${bookingRef}</strong> für ${dateDisplay} um ${booking.time} Uhr wurde storniert.</p>
        <p style="margin:0; font-size:13.5px; color:#6b6b74; line-height:1.5;">Falls Sie einen neuen Termin buchen möchten, besuchen Sie gerne erneut unsere Website.</p>
        <p style="margin:22px 0 0; font-size:13px; font-weight:700; color:#111114;">Ihr Zettly-Team</p>
      </div>
    </div>
  </div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from,
      to: booking.customer_email,
      subject: `Stornierung Buchung ${bookingRef}`,
      html,
    }),
  });
  return { sent: res.ok };
}
