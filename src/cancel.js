// Public, token-authenticated self-service cancellation. No admin session
// involved: a customer reaches this only via the signed link in their
// confirmation email (see src/index.js -> createCancelToken), which proves
// they have the email without needing a login of their own.

import catalog from "../catalog.json";
import { verifyCancelToken } from "./auth.js";
import { json, minutesUntil, localizedDate, logActivity } from "./utils.js";
import { breadcrumbFromServiceId } from "./catalog-utils.js";
import { sendCancellationEmail, sendAdminCancellationNotification } from "./notify.js";

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

  // The bookings table only stores the leaf service_name ("New setup"); the
  // full selection path ("Zuhause › Computer & Netzwerke › New setup") is
  // reconstructed from the stored service_id against the current catalog,
  // falling back to just the leaf name if that ever fails to resolve.
  const breadcrumb = breadcrumbFromServiceId(catalog, row.service_id, lang);
  const serviceName = breadcrumb ? breadcrumb.join(" › ") : row.service_name;

  return json({
    bookingRef: `ZTL-${row.id.split("-")[0].toUpperCase()}`,
    customerName: row.customer_name,
    serviceName,
    date: row.date,
    dateDisplay: localizedDate(row.date, lang),
    time: row.time,
    durationMinutes: row.duration_minutes,
    price: row.price,
    quantity: row.quantity || 1,
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
  if (reason.length > 100) {
    return json({ error: "Cancellation reason must be 100 characters or fewer" }, 400);
  }

  // Cancelling always clears any payment-pending/paid state to
  // "not_applicable" -- a cancelled booking isn't owed or collected on,
  // so it shouldn't keep showing as a pending payment on the dashboard.
  await env.DB.prepare(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancellation_reason = ?, payment_status = 'not_applicable', paid_at = NULL WHERE id = ?`
  )
    .bind(new Date().toISOString().replace("Z", ""), reason, row.id)
    .run();

  await logActivity(env, row.id, "cancelled", "customer", `Cancelled by customer (reason: ${reason})`);

  const lang = body.lang === "de" ? "de" : "en";
  const cancelledRow = { ...row, cancellation_reason: reason };
  const emailResult = await sendCancellationEmail(env, cancelledRow, lang, { cancelledBy: "customer" });
  // Best-effort heads-up to the owner; must never affect the response the
  // customer sees, so its own failure is swallowed here.
  try {
    await sendAdminCancellationNotification(env, cancelledRow);
  } catch {
    // ignore — admin notification is not on the customer-facing critical path
  }

  return json({ ok: true, emailSent: emailResult.sent });
}
