// Public, token-authenticated self-service cancellation. No admin session
// involved: a customer reaches this only via the signed link in their
// confirmation email (see src/index.js -> createCancelToken), which proves
// they have the email without needing a login of their own.

import { verifyCancelToken } from "./auth.js";
import { json, minutesUntil, localizedDate } from "./utils.js";
import { sendCancellationEmail } from "./notify.js";

const CANCEL_CUTOFF_MINUTES = 24 * 60;

async function loadBookingForToken(env, token) {
  if (!env.SESSION_SECRET) return { error: json({ error: "Not configured" }, 503) };
  const payload = await verifyCancelToken(env.SESSION_SECRET, token);
  if (!payload) return { error: json({ error: "Invalid or expired link" }, 400) };
  const row = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(payload.bookingId).first();
  if (!row) return { error: json({ error: "Booking not found" }, 404) };
  return { row };
}

export async function handleCancelInfo(url, env) {
  const token = url.searchParams.get("token") || "";
  const { row, error } = await loadBookingForToken(env, token);
  if (error) return error;

  const lang = url.searchParams.get("lang") === "de" ? "de" : "en";
  const mins = minutesUntil(row.date, row.time);
  const canCancel = row.status === "confirmed" && mins >= CANCEL_CUTOFF_MINUTES;

  return json({
    bookingRef: `ZTL-${row.id.split("-")[0].toUpperCase()}`,
    serviceName: row.service_name,
    date: row.date,
    dateDisplay: localizedDate(row.date, lang),
    time: row.time,
    durationMinutes: row.duration_minutes,
    price: row.price,
    address: row.customer_address,
    status: row.status,
    canCancel,
    hoursUntil: Math.max(0, Math.floor(mins / 60)),
  });
}

export async function handleCancelSubmit(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  const { row, error } = await loadBookingForToken(env, body?.token || "");
  if (error) return error;

  if (row.status !== "confirmed") {
    return json({ error: "This booking is not active", status: row.status }, 409);
  }
  const mins = minutesUntil(row.date, row.time);
  if (mins < CANCEL_CUTOFF_MINUTES) {
    return json({ error: "Cancellation window has passed (less than 24 hours to the appointment)" }, 409);
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return json({ error: "A cancellation reason is required" }, 400);
  }

  await env.DB.prepare(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancellation_reason = ? WHERE id = ?`
  )
    .bind(new Date().toISOString().replace("Z", ""), reason, row.id)
    .run();

  const lang = body.lang === "de" ? "de" : "en";
  const emailResult = await sendCancellationEmail(env, { ...row, cancellation_reason: reason }, lang);

  return json({ ok: true, emailSent: emailResult.sent });
}
