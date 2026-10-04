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
import { json, berlinNow } from "./utils.js";
import { setBookingEnabled, getBookingStatuses, BOOKING_AUDIENCES } from "./settings.js";
import { sendCancellationEmail, sendInvoiceEmail, sendPaymentLinkEmail } from "./notify.js";
import { sendConfirmationEmail } from "./index.js";
import catalog from "../catalog.json";
import { breadcrumbFromServiceId, resolveLeaf, fullBreadcrumb } from "./catalog-utils.js";

// The bookings table only stores the leaf service_name ("New setup"); the
// admin dashboard wants the full selection path the customer walked through
// ("Home › Computers & Laptops › New setup › Up to 10 GB"), reconstructed
// from the stored service_id against the current catalog. Resolved in both
// languages so the admin UI's language toggle doesn't need another request.
function withServiceBreadcrumb(row) {
  const breadcrumbEn = breadcrumbFromServiceId(catalog, row.service_id, "en");
  const breadcrumbDe = breadcrumbFromServiceId(catalog, row.service_id, "de");
  // Re-resolved from the catalog rather than stored on the row, same as the
  // breadcrumbs above -- lets the admin UI show "Online"/"In person" (and
  // only for leaves that actually offer it) without duplicating the
  // quoteKind convention client-side.
  const [svcAudience, svcCategoryId, ...svcPath] = (row.service_id || "").split(":");
  const resolvedLeaf = svcAudience && svcCategoryId ? resolveLeaf(catalog, svcAudience, svcCategoryId, svcPath)?.leaf : null;
  return {
    ...row,
    serviceBreadcrumbEn: breadcrumbEn || [row.service_name],
    serviceBreadcrumbDe: breadcrumbDe || [row.service_name],
    is_consultation: resolvedLeaf?.quoteKind === "consultation",
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
            customer_phone, customer_company, customer_address, notes, status, payment_status, paid_at, created_at, cancelled_at, cancellation_reason, online_consultation, quantity,
            (attachment_data IS NOT NULL) AS has_attachment
     FROM bookings ${whereSql}
     ORDER BY date DESC, time DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all();

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM bookings ${whereSql}`)
    .bind(...params)
    .first();

  // Summary cards on the dashboard: totals across whatever filters are
  // currently applied (search/date range/status), broken down by status and
  // by payment state so the UI can show, e.g., confirmed vs. cancelled vs.
  // completed value, and paid vs. still-pending revenue, side by side. These
  // intentionally use the SAME where/params as the paginated list above, so
  // picking a status filter narrows the cards exactly like it narrows the
  // table.
  const { results: statusRows } = await env.DB.prepare(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(price + commute_fee), 0) AS sum
     FROM bookings ${whereSql}
     GROUP BY status`
  )
    .bind(...params)
    .all();

  // Paid/pending is independent of status, except "pending" explicitly
  // excludes cancelled bookings (an unpaid cancelled booking isn't money
  // still owed).
  const { results: paymentRows } = await env.DB.prepare(
    `SELECT payment_status, COUNT(*) AS n, COALESCE(SUM(price + commute_fee), 0) AS sum
     FROM bookings ${whereSql}${whereSql ? " AND" : "WHERE"} status != 'cancelled'
     GROUP BY payment_status`
  )
    .bind(...params)
    .all();

  const stats = {
    count: 0,
    totalAmount: 0,
    confirmedCount: 0,
    confirmedAmount: 0,
    cancelledCount: 0,
    cancelledAmount: 0,
    completedCount: 0,
    completedAmount: 0,
    paidCount: 0,
    paidAmount: 0,
    pendingCount: 0,
    pendingAmount: 0,
  };
  for (const row of statusRows) {
    stats.count += row.n;
    stats.totalAmount += row.sum;
    if (row.status === "confirmed") { stats.confirmedCount += row.n; stats.confirmedAmount += row.sum; }
    if (row.status === "cancelled") { stats.cancelledCount += row.n; stats.cancelledAmount += row.sum; }
    if (row.status === "completed") { stats.completedCount += row.n; stats.completedAmount += row.sum; }
  }
  for (const row of paymentRows) {
    if (row.payment_status === "paid") { stats.paidCount += row.n; stats.paidAmount += row.sum; }
    if (row.payment_status === "pending") { stats.pendingCount += row.n; stats.pendingAmount += row.sum; }
  }

  const bookings = results.map((r) => withServiceBreadcrumb({ ...r, bookingRef: `ZTL-${r.id.split("-")[0].toUpperCase()}` }));
  return json({ bookings, total: totalRow?.n || 0, limit, offset, stats });
}

// Small, dedicated endpoint for just the (possibly large, base64) attachment
// fields, so the bookings table can lazy-load a thumbnail per row with an
// attachment without the main list query ever sending that payload for
// every row on the page -- the list query only carries the cheap
// has_attachment boolean.
export async function handleAdminBookingAttachment(env, id) {
  const row = await env.DB.prepare(
    `SELECT attachment_data, attachment_filename, attachment_content_type FROM bookings WHERE id = ?`
  )
    .bind(id)
    .first();
  if (!row || !row.attachment_data) return json({ error: "Not found" }, 404);
  return json({
    dataUrl: `data:${row.attachment_content_type};base64,${row.attachment_data}`,
    filename: row.attachment_filename,
  });
}

export async function handleAdminBookingDetail(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, service_id, service_name, price, commute_fee, commute_distance_km, duration_minutes, date, time, customer_name, customer_email,
            customer_phone, customer_company, customer_address, notes, status, payment_status, paid_at, created_at, cancelled_at, cancellation_reason, online_consultation, quantity,
            (attachment_data IS NOT NULL) AS has_attachment
     FROM bookings WHERE id = ?`
  )
    .bind(id)
    .first();
  if (!row) return json({ error: "Not found" }, 404);
  return json(withServiceBreadcrumb({ ...row, bookingRef: `ZTL-${row.id.split("-")[0].toUpperCase()}` }));
}

// Permanently removes a booking row. This is a hard delete (unlike
// cancelling, which keeps the row with a cancelled_at timestamp) -- meant
// for cleaning up test bookings or genuine mistakes, not for the normal
// cancellation flow, which should still go through handleAdminUpdateStatus
// so the customer gets a cancellation email and the record stays for
// history. No customer notification is sent here.
export async function handleAdminDeleteBooking(request, env, id) {
  if (!hasAdminHeader(request)) return json({ error: "Bad request" }, 400);
  const existing = await env.DB.prepare(`SELECT id FROM bookings WHERE id = ?`).bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404);
  await env.DB.prepare(`DELETE FROM bookings WHERE id = ?`).bind(id).run();
  return json({ ok: true });
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

  // Cancelling always clears any payment-pending/paid state to
  // "not_applicable" -- a cancelled booking isn't owed or collected on, so
  // it shouldn't keep showing as a pending payment on the dashboard.
  // Reactivating (confirming/completing a previously-cancelled booking)
  // puts it back to "pending" -- its prior paid/pending state before the
  // cancellation isn't tracked, so this is the safer default for an admin
  // to then re-mark as paid if it actually was.
  await env.DB.prepare(
    `UPDATE bookings SET status = ?, cancelled_at = ?, cancellation_reason = ?, payment_status = ?, paid_at = ? WHERE id = ?`
  )
    .bind(
      body.status,
      cancelling ? new Date().toISOString().replace("Z", "") : reactivating ? null : existing.cancelled_at,
      cancelling ? reason : reactivating ? null : existing.cancellation_reason,
      cancelling ? "not_applicable" : reactivating ? "pending" : existing.payment_status,
      cancelling ? null : reactivating ? null : existing.paid_at,
      id
    )
    .run();

  // Re-confirming (setting a cancelled or completed booking back to
  // "confirmed") is treated like the original booking-confirmation email:
  // the customer gets the same confirmation email, with both PDFs
  // attached, as when they first booked.
  const reconfirming = body.status === "confirmed" && existing.status !== "confirmed";

  let emailSent = false;
  if (cancelling && body.notifyCustomer !== false) {
    emailSent = (
      await sendCancellationEmail(env, { ...existing, cancellation_reason: reason }, body.lang === "en" ? "en" : "de", { cancelledBy: "admin" })
    ).sent;
  } else if (reconfirming && body.notifyCustomer !== false) {
    const lang = body.lang === "en" ? "en" : "de";
    const [audience, categoryId, ...path] = (existing.service_id || "").split(":");
    const resolved = audience && categoryId ? resolveLeaf(catalog, audience, categoryId, path) : null;
    if (resolved) {
      const bookingRef = `ZTL-${existing.id.split("-")[0].toUpperCase()}`;
      const bookingForEmail = {
        id: existing.id,
        bookingRef,
        breadcrumbDe: fullBreadcrumb(resolved, audience, "de"),
        breadcrumbEn: fullBreadcrumb(resolved, audience, "en"),
        date: existing.date,
        time: existing.time,
        customer_name: existing.customer_name,
        customer_email: existing.customer_email,
        customer_address: existing.customer_address,
        commuteFee: existing.commute_fee || 0,
        onlineConsultation: !!existing.online_consultation,
        liabilityAcceptedAt: existing.liability_accepted_at,
        privacyAcceptedAt: existing.privacy_accepted_at,
      };
      // Built from the recorded row, not re-derived from the catalog leaf:
      // `existing.price` is the actual total the customer was charged
      // (already quantity-multiplied at booking time, and immune to any
      // catalog price change since), and `existing.quantity` is what they
      // actually booked -- resolved.leaf only supplies the "is this a
      // quote" flag, which doesn't change booking to booking.
      const quantity = existing.quantity || 1;
      const serviceForEmail = {
        duration: existing.duration_minutes,
        price: resolved.leaf.quote ? null : existing.price,
        quote: !!resolved.leaf.quote,
        quoteKind: resolved.leaf.quoteKind || null,
        isConsultation: resolved.leaf.quoteKind === "consultation",
        quantity,
        unitPrice: resolved.leaf.quote ? null : Math.round((existing.price / quantity) * 100) / 100,
      };
      emailSent = (await sendConfirmationEmail(env, bookingForEmail, serviceForEmail, lang)).sent;
    }
  }

  return json({ ok: true, id, status: body.status, emailSent });
}

const VALID_PAYMENT_STATUSES = ["paid", "pending"];

// Separate from handleAdminUpdateStatus (booking status: confirmed /
// cancelled / completed) -- payment_status tracks whether the customer has
// actually paid, independent of that. Today this is only ever flipped by an
// admin clicking "Mark as paid" / "Mark as pending" in the dashboard; once a
// payment gateway is wired up, its webhook can call this same column (or an
// equivalent internal update) to set payment_status = 'paid' automatically
// on a successful online payment, with no further schema change needed.
export async function handleAdminSetPaymentStatus(request, env, id) {
  if (!hasAdminHeader(request)) return json({ error: "Bad request" }, 400);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  if (!VALID_PAYMENT_STATUSES.includes(body?.paymentStatus)) {
    return json({ error: "Invalid payment status" }, 400);
  }
  const existing = await env.DB.prepare(`SELECT id, status, paid_at FROM bookings WHERE id = ?`).bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404);
  // A cancelled booking's payment status is "not_applicable", set
  // automatically when it was cancelled -- not something to manually flip
  // to paid/pending from here.
  if (existing.status === "cancelled") return json({ error: "Booking is cancelled" }, 400);

  const markingPaid = body.paymentStatus === "paid";
  await env.DB.prepare(`UPDATE bookings SET payment_status = ?, paid_at = ? WHERE id = ?`)
    .bind(
      body.paymentStatus,
      markingPaid ? new Date().toISOString().replace("Z", "") : null,
      id
    )
    .run();

  return json({ ok: true, id, paymentStatus: body.paymentStatus });
}

// ---- Invoice / payment link (manual admin actions on a booking) ---------

export async function handleAdminSendInvoice(request, env, id) {
  if (!hasAdminHeader(request)) return json({ error: "Bad request" }, 400);
  let body = {};
  try {
    body = await request.json();
  } catch {
    // A body is optional here (defaults to German); only reject genuinely
    // malformed JSON when one was actually sent.
    if ((request.headers.get("content-length") || "0") !== "0") return json({ error: "Invalid request" }, 400);
  }
  const existing = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404);
  // An invoice documents a completed payment, so it's only available once
  // the booking is actually marked paid -- not while payment is still
  // pending or the booking has been cancelled (payment_status
  // "not_applicable").
  if (existing.payment_status !== "paid") return json({ error: "Booking is not marked as paid yet" }, 400);

  const lang = body?.lang === "en" ? "en" : "de";
  const result = await sendInvoiceEmail(env, existing, lang);
  return json({ ok: true, emailSent: result.sent, reason: result.reason });
}

export async function handleAdminSendPaymentLink(request, env, id) {
  if (!hasAdminHeader(request)) return json({ error: "Bad request" }, 400);
  let body = {};
  try {
    body = await request.json();
  } catch {
    if ((request.headers.get("content-length") || "0") !== "0") return json({ error: "Invalid request" }, 400);
  }
  const existing = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404);

  const lang = body?.lang === "en" ? "en" : "de";
  const result = await sendPaymentLinkEmail(env, existing, lang);
  return json({ ok: true, emailSent: result.sent, reason: result.reason, paymentLink: result.paymentLink });
}

// ---- Calendar blocks (admin-only "block myself out" days/half-days) -----

const VALID_BLOCK_PERIODS = ["full", "am", "pm"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// A generous cap on how many days a single block request can cover, just to
// stop a typo'd end date (or a malicious request) from writing thousands of
// rows in one go.
const MAX_BLOCK_RANGE_DAYS = 92;

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export async function handleAdminListBlocks(url, env) {
  const from = url.searchParams.get("from") || berlinNow().date;
  const { results } = await env.DB.prepare(
    `SELECT id, date, period, reason, created_at FROM calendar_blocks WHERE date >= ? ORDER BY date ASC, period ASC`
  )
    .bind(from)
    .all();
  return json({ blocks: results });
}

export async function handleAdminCreateBlock(request, env) {
  if (!hasAdminHeader(request)) return json({ error: "Bad request" }, 400);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }

  const { startDate, endDate, period } = body || {};
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 120) : null;

  if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate || startDate)) {
    return json({ error: "Invalid date" }, 400);
  }
  if (!VALID_BLOCK_PERIODS.includes(period)) {
    return json({ error: "Invalid period" }, 400);
  }
  const end = endDate || startDate;
  if (end < startDate) {
    return json({ error: "End date must be on or after the start date" }, 400);
  }

  const dates = [];
  for (let d = startDate; d <= end; d = addDays(d, 1)) {
    dates.push(d);
    if (dates.length > MAX_BLOCK_RANGE_DAYS) {
      return json({ error: `Please block at most ${MAX_BLOCK_RANGE_DAYS} days at a time` }, 400);
    }
  }

  for (const date of dates) {
    const existing = await env.DB.prepare(`SELECT id, period FROM calendar_blocks WHERE date = ?`).bind(date).all();
    // A day already blocked in full stays that way — adding a half-day block
    // on top of it would be a no-op, so it's skipped rather than duplicated.
    if (existing.results.some((r) => r.period === "full")) continue;
    if (period === "full") {
      // A full-day block supersedes any half-day blocks already on that date.
      for (const r of existing.results) {
        await env.DB.prepare(`DELETE FROM calendar_blocks WHERE id = ?`).bind(r.id).run();
      }
    } else {
      const dup = existing.results.find((r) => r.period === period);
      if (dup) {
        await env.DB.prepare(`DELETE FROM calendar_blocks WHERE id = ?`).bind(dup.id).run();
      }
    }
    await env.DB.prepare(`INSERT INTO calendar_blocks (id, date, period, reason) VALUES (?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), date, period, reason || null)
      .run();
  }

  return json({ ok: true, blockedDates: dates.length });
}

export async function handleAdminDeleteBlock(request, env, id) {
  if (!hasAdminHeader(request)) return json({ error: "Bad request" }, 400);
  await env.DB.prepare(`DELETE FROM calendar_blocks WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

// ---- Per-audience "bookings enabled" switches (no date range — just on/off,
// one for home customers and one for business customers) -----------------

export async function handleAdminGetBookingStatus(env) {
  return json(await getBookingStatuses(env));
}

export async function handleAdminSetBookingStatus(request, env) {
  if (!hasAdminHeader(request)) return json({ error: "Bad request" }, 400);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  if (!BOOKING_AUDIENCES.includes(body?.audience) || typeof body?.enabled !== "boolean") {
    return json({ error: "Invalid request" }, 400);
  }
  await setBookingEnabled(env, body.audience, body.enabled);
  return json({ ok: true, ...(await getBookingStatuses(env)) });
}
