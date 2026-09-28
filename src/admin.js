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
import { json } from "./utils.js";
import { sendCancellationEmail } from "./notify.js";
import catalog from "../catalog.json";
import { breadcrumbFromServiceId } from "./catalog-utils.js";

// The bookings table only stores the leaf service_name ("New setup"); the
// admin dashboard wants the full selection path the customer walked through
// ("Home › Computers & Laptops › New setup › Up to 10 GB"), reconstructed
// from the stored service_id against the current catalog. Resolved in both
// languages so the admin UI's language toggle doesn't need another request.
function withServiceBreadcrumb(row) {
  const breadcrumbEn = breadcrumbFromServiceId(catalog, row.service_id, "en");
  const breadcrumbDe = breadcrumbFromServiceId(catalog, row.service_id, "de");
  return {
    ...row,
    serviceBreadcrumbEn: breadcrumbEn || [row.service_name],
    serviceBreadcrumbDe: breadcrumbDe || [row.service_name],
  };
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

  // Built without the status filter so it can be reused, unmodified, for the
  // status-independent summary-card totals below; the paginated list query
  // adds the status clause back on top of these.
  const baseWhere = [];
  const baseParams = [];
  if (date) {
    baseWhere.push("date = ?");
    baseParams.push(date);
  }
  if (from) {
    baseWhere.push("date >= ?");
    baseParams.push(from);
  }
  if (to) {
    baseWhere.push("date <= ?");
    baseParams.push(to);
  }
  if (q) {
    baseWhere.push("(customer_name LIKE ? OR customer_email LIKE ? OR id LIKE ?)");
    const like = `%${q}%`;
    baseParams.push(like, like, like);
  }

  const where = status ? ["status = ?", ...baseWhere] : [...baseWhere];
  const params = status ? [status, ...baseParams] : [...baseParams];
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const { results } = await env.DB.prepare(
    `SELECT id, service_id, service_name, price, commute_fee, commute_distance_km, duration_minutes, date, time, customer_name, customer_email,
            customer_phone, customer_address, notes, status, created_at, cancelled_at, cancellation_reason
     FROM bookings ${whereSql}
     ORDER BY date DESC, time DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all();

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bookings ${whereSql}`)
    .bind(...params)
    .first();

  // Summary cards on the dashboard: totals across whatever the current
  // filters select (search/date range), independent of the status filter
  // and of pagination, broken down by status so the UI can show completed
  // vs. still-pending revenue alongside the grand total.
  const baseWhereSql = baseWhere.length ? `WHERE ${baseWhere.join(" AND ")}` : "";
  const { results: statusRows } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(price + commute_fee), 0) AS sum
     FROM bookings ${baseWhereSql}
     GROUP BY status`
  )
    .bind(...baseParams)
    .all();

  const stats = { count: 0, totalAmount: 0, completedAmount: 0, pendingAmount: 0 };
  for (const row of statusRows) {
    stats.count += row.n;
    if (row.status !== "cancelled") stats.totalAmount += row.sum;
    if (row.status === "completed") stats.completedAmount += row.sum;
    if (row.status === "confirmed") stats.pendingAmount += row.sum;
  }

  const bookings = results.map((r) => withServiceBreadcrumb({ ...r, bookingRef: `ZTL-${r.id.split("-")[0].toUpperCase()}` }));
  return json({ bookings, total: totalRow?.n || 0, limit, offset, stats });
}

export async function handleAdminBookingDetail(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, service_id, service_name, price, commute_fee, commute_distance_km, duration_minutes, date, time, customer_name, customer_email,
            customer_phone, customer_address, notes, status, created_at, cancelled_at, cancellation_reason
     FROM bookings WHERE id = ?`
  )
    .bind(id)
    .first();
  if (!row) return json({ error: "Not found" }, 404);
  return json(withServiceBreadcrumb({ ...row, bookingRef: `ZTL-${row.id.split("-")[0].toUpperCase()}` }));
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

  const cancelling = body.status === "cancelled" && existing.status !== "cancelled";
  // Reactivating a previously-cancelled booking clears the cancellation
  // record; anything else leaves cancelled_at/cancellation_reason as the
  // historical record of when and why it was cancelled.
  const reactivating = existing.status === "cancelled" && body.status !== "cancelled";

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (cancelling && !reason) {
    return json({ error: "A cancellation reason is required" }, 400);
  }
  if (cancelling && reason.length > 100) {
    return json({ error: "Cancellation reason must be 100 characters or fewer" }, 400);
  }

  await env.DB.prepare(
    `UPDATE bookings SET status = ?, cancelled_at = ?, cancellation_reason = ? WHERE id = ?`
  )
    .bind(
      body.status,
      cancelling ? new Date().toISOString().replace("Z", "") : reactivating ? null : existing.cancelled_at,
      cancelling ? reason : reactivating ? null : existing.cancellation_reason,
      id
    )
    .run();

  let emailSent = false;
  if (cancelling && body.notifyCustomer !== false) {
    emailSent = (
      await sendCancellationEmail(env, { ...existing, cancellation_reason: reason }, body.lang === "en" ? "en" : "de", { cancelledBy: "admin" })
    ).sent;
  }

  return json({ ok: true, id, status: body.status, emailSent });
}
