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
import { json, berlinNow, isValidEmail, logActivity, minutesUntil, toMinutes, LATE_CANCEL_CUTOFF_MINUTES, computeLateCancellationFee, TRAVEL_FEE_CUTOFF_MINUTES } from "./utils.js";
import { setBookingEnabled, getBookingStatuses, BOOKING_AUDIENCES } from "./settings.js";
import { sendCancellationEmail, sendInvoiceEmail, sendPaymentLinkEmail } from "./notify.js";
import { sendConfirmationEmail, parseAttachment, bookingBlocksSlot, loadBlockedChecker } from "./index.js";
import catalog from "../catalog.json";
import { breadcrumbFromServiceId, resolveLeaf, fullBreadcrumb, listCatalogLeaves } from "./catalog-utils.js";

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
    // Quote-type leaves (consultation or "price given on-site") are booked
    // with price = 0, the real price only known later -- the admin "Set
    // price" action is offered for these.
    is_quote: !!resolvedLeaf?.quote,
    audience: svcAudience === "business" ? "business" : "home",
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
  const audience = url.searchParams.get("audience"); // home | business | (empty = all) -- derived from the service_id prefix, not a stored column
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
  if (audience === "home" || audience === "business") {
    baseWhere.push("service_id LIKE ?");
    baseParams.push(`${audience}:%`);
  }

  const where = status ? ["status = ?", ...baseWhere] : [...baseWhere];
  const params = status ? [status, ...baseParams] : [...baseParams];
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const { results } = await env.DB.prepare(
    `SELECT id, service_id, service_name, price, commute_fee, commute_distance_km, duration_minutes, date, time, customer_name, customer_first_name, customer_last_name, customer_email,
            customer_phone, customer_company, customer_address, notes, status, payment_status, paid_at, created_at, cancelled_at, cancellation_reason, online_consultation, quantity, source_booking_id, created_by, pre_cancellation_price, cancellation_fee_waived, no_show, pre_cancellation_commute_fee, travel_fee_waived,
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

  // Paid/pending is independent of status. A cancelled booking with nothing
  // owed is payment_status = 'not_applicable' and so never lands in the
  // pending/paid totals below -- but a cancelled booking CAN owe a late-
  // cancellation fee and/or a travel fee (see src/admin.js / src/cancel.js),
  // in which case it's payment_status = 'pending' like any other unpaid
  // charge and must be counted here too. This used to filter out
  // `status != 'cancelled'` entirely, from before a cancelled booking could
  // ever owe money -- that filter was silently excluding real pending fees
  // from the dashboard's "pending" total.
  const { results: paymentRows } = await env.DB.prepare(
    `SELECT payment_status, COUNT(*) AS n, COALESCE(SUM(price + commute_fee), 0) AS sum
     FROM bookings ${whereSql}
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

// ---- Evidence photos (admin-added, after the booking exists) ------------
//
// Separate from the customer's own booking-time attachment above: any
// number of photos per booking, each with its own timestamp (created_at)
// and a short optional note -- e.g. a picture of the equipment before work
// starts, taken with the customer's permission. A cap of 20 keeps a single
// booking's photos from growing unbounded.
const MAX_EVIDENCE_PHOTOS_PER_BOOKING = 20;

// List metadata only (id, note, timestamp, filename) -- never the base64
// image data -- so the modal can show a thumbnail strip without pulling
// every photo's full payload down just to open the booking.
export async function handleAdminListEvidence(env, bookingId) {
  const { results } = await env.DB.prepare(
    `SELECT id, filename, content_type, note, created_at FROM booking_evidence WHERE booking_id = ? ORDER BY created_at ASC`
  )
    .bind(bookingId)
    .all();
  return json({ photos: results });
}

// One photo's full image data, fetched lazily per-thumbnail-click, same
// pattern as handleAdminBookingAttachment above.
export async function handleAdminGetEvidencePhoto(env, bookingId, evidenceId) {
  const row = await env.DB.prepare(
    `SELECT image_data, content_type, filename, note, created_at FROM booking_evidence WHERE id = ? AND booking_id = ?`
  )
    .bind(evidenceId, bookingId)
    .first();
  if (!row) return json({ error: "Not found" }, 404);
  return json({
    dataUrl: `data:${row.content_type};base64,${row.image_data}`,
    filename: row.filename,
    note: row.note,
    created_at: row.created_at,
  });
}

export async function handleAdminAddEvidence(request, env, bookingId) {
  if (!hasAdminHeader(request)) return json({ error: "Bad request" }, 400);
  const existing = await env.DB.prepare(`SELECT id FROM bookings WHERE id = ?`).bind(bookingId).first();
  if (!existing) return json({ error: "Not found" }, 404);

  const { count } = (await env.DB.prepare(`SELECT COUNT(*) AS count FROM booking_evidence WHERE booking_id = ?`).bind(bookingId).first()) || { count: 0 };
  if (count >= MAX_EVIDENCE_PHOTOS_PER_BOOKING) {
    return json({ error: `A booking can have at most ${MAX_EVIDENCE_PHOTOS_PER_BOOKING} evidence photos` }, 400);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  const parsed = parseAttachment(body?.photo);
  if (!parsed) return json({ error: "Invalid or missing photo" }, 400);
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 300) || null : null;

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO booking_evidence (id, booking_id, image_data, content_type, filename, note) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, bookingId, parsed.base64, parsed.contentType, parsed.filename, note)
    .run();

  const row = await env.DB.prepare(`SELECT id, filename, content_type, note, created_at FROM booking_evidence WHERE id = ?`).bind(id).first();
  await logActivity(env, bookingId, "evidence_uploaded", "admin", note ? `Added evidence photo: ${note}` : "Added an evidence photo");
  return json({ ok: true, photo: row });
}

export async function handleAdminDeleteEvidence(request, env, bookingId, evidenceId) {
  if (!hasAdminHeader(request)) return json({ error: "Bad request" }, 400);
  const existing = await env.DB.prepare(`SELECT id, filename FROM booking_evidence WHERE id = ? AND booking_id = ?`).bind(evidenceId, bookingId).first();
  if (!existing) return json({ error: "Not found" }, 404);
  await env.DB.prepare(`DELETE FROM booking_evidence WHERE id = ?`).bind(evidenceId).run();
  await logActivity(env, bookingId, "evidence_deleted", "admin", existing.filename ? `Removed evidence photo: ${existing.filename}` : "Removed an evidence photo");
  return json({ ok: true });
}

// Activity timeline for a booking -- the "View logs" page on the admin
// dashboard reads this. Newest first, so the most recent event is always at
// the top.
export async function handleAdminGetActivity(env, bookingId) {
  const booking = await env.DB.prepare(`SELECT id FROM bookings WHERE id = ?`).bind(bookingId).first();
  if (!booking) return json({ error: "Not found" }, 404);
  const { results } = await env.DB.prepare(
    `SELECT id, action, actor, detail, created_at FROM booking_activity_log WHERE booking_id = ? ORDER BY created_at DESC, id DESC`
  )
    .bind(bookingId)
    .all();
  return json({ activity: results });
}

export async function handleAdminBookingDetail(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, service_id, service_name, price, commute_fee, commute_distance_km, duration_minutes, date, time, customer_name, customer_first_name, customer_last_name, customer_email,
            customer_phone, customer_company, customer_address, notes, status, payment_status, paid_at, created_at, cancelled_at, cancellation_reason, online_consultation, quantity, source_booking_id, created_by, pre_cancellation_price, cancellation_fee_waived, no_show, pre_cancellation_commute_fee, travel_fee_waived,
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

// Fulfils a GDPR Art. 17 erasure request (privacy policy section 10).
//
// German commercial/tax law (§ 257 HGB, § 147 AO) requires invoices to be
// kept for up to 10 years, so a booking that's been invoiced can't be hard
// deleted -- instead its personal data is scrubbed while the financial
// record (service, price, date, status) stays intact, per Art. 18 GDPR
// ("restriction of processing" rather than erasure). A booking that was
// never invoiced carries no such obligation, so it's hard deleted outright,
// same as handleAdminDeleteBooking above but reached from the "customer
// asked us to delete their data" flow and logged accordingly before the
// row (and its cascaded evidence/activity rows) disappear.
export async function handleAdminRequestErasure(request, env, id) {
  if (!hasAdminHeader(request)) return json({ error: "Bad request" }, 400);
  const existing = await env.DB.prepare(`SELECT id FROM bookings WHERE id = ?`).bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404);

  const invoiced = await env.DB.prepare(
    `SELECT 1 FROM booking_activity_log WHERE booking_id = ? AND action = 'invoice_sent' LIMIT 1`
  )
    .bind(id)
    .first();

  if (!invoiced) {
    // No legal retention obligation attaches yet -- honor the request in
    // full. ON DELETE CASCADE removes booking_evidence and
    // booking_activity_log rows along with it, so nothing is logged after
    // (there'd be nothing left to attach the log entry to).
    await env.DB.prepare(`DELETE FROM bookings WHERE id = ?`).bind(id).run();
    return json({ ok: true, result: "deleted" });
  }

  // Invoiced: keep the booking row (it's the financial record) but erase
  // every personal-data field on it, and remove any evidence photos, which
  // are personal data with no retention requirement of their own.
  await env.DB.prepare(
    `UPDATE bookings SET
       customer_name = 'Erased',
       customer_first_name = NULL,
       customer_last_name = NULL,
       customer_email = 'erased@erased.invalid',
       customer_phone = NULL,
       customer_company = NULL,
       customer_address = '',
       notes = NULL,
       attachment_data = NULL,
       attachment_filename = NULL,
       attachment_content_type = NULL,
       attachment_size = NULL
     WHERE id = ?`
  )
    .bind(id)
    .run();
  await env.DB.prepare(`DELETE FROM booking_evidence WHERE booking_id = ?`).bind(id).run();
  await logActivity(
    env,
    id,
    "gdpr_erasure",
    "admin",
    "Customer data erased on request; invoice/financial record retained for the legal retention period"
  );
  return json({ ok: true, result: "anonymized" });
}

const VALID_STATUSES = ["confirmed", "cancelled", "completed", "processing"];

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

  // A booking cancelled less than 24h before its appointment owes the
  // late-cancellation fee (50% of price, capped -- see computeLateCancellationFee)
  // automatically, unless the admin explicitly opts to waive it right here
  // (body.waiveFee) -- e.g. a goodwill exception for a regular customer.
  // `price` is overwritten to the fee amount so payment status/invoices/
  // payment links downstream keep working unchanged against "what's owed",
  // and the original price is kept in pre_cancellation_price. Reactivating a
  // cancelled booking undoes all of this: price goes back to what it was
  // before any fee, and the fee bookkeeping is cleared.
  let newPrice = existing.price;
  let prePrice = existing.pre_cancellation_price;
  let feeWaived = existing.cancellation_fee_waived;
  let lateFeeAmount = 0;
  let lateFeeApplied = false;

  // Marking a cancellation as a no-show (admin-only; set via a checkbox on
  // the cancellation confirm dialog). A no-show, by definition, happens at
  // or after the appointment time, so it always counts as "close enough" for
  // the travel-fee-keeping logic below, regardless of the 3h cutoff. It
  // never applies to an online-video-call consultation -- there's no
  // physical address to not be reachable at -- so the flag is forced off
  // server-side even if the client somehow sent it.
  const noShow = cancelling && body.noShow === true && !existing.online_consultation;

  // The travel/commute fee (if the booking had one) is kept -- charged --
  // only when the cancellation happens less than TRAVEL_FEE_CUTOFF_MINUTES
  // before the appointment, or the booking is marked a no-show; otherwise it
  // is waived back to 0 (the customer didn't cause us to actually travel).
  // This is a separate, tighter window than the 24h service-price late fee
  // above -- a booking can owe the late fee without owing the travel fee.
  // An admin can also explicitly waive it via body.waiveTravelFee, the same
  // way body.waiveFee waives the late-cancellation fee.
  let newCommuteFee = existing.commute_fee || 0;
  let preCommuteFee = existing.pre_cancellation_commute_fee;
  let travelFeeKept = false;
  let travelFeeWaived = existing.travel_fee_waived;

  if (cancelling) {
    const mins = minutesUntil(existing.date, existing.time);
    lateFeeAmount = mins < LATE_CANCEL_CUTOFF_MINUTES ? computeLateCancellationFee(existing.price) : 0;
    lateFeeApplied = lateFeeAmount > 0 && body.waiveFee !== true;
    newPrice = lateFeeApplied ? lateFeeAmount : existing.price;
    prePrice = lateFeeApplied ? existing.price : null;
    // Recorded even when nothing is actually owed yet, so the dashboard can
    // show "fee waived" rather than looking like the cancellation was simply
    // never late in the first place.
    feeWaived = lateFeeAmount > 0 && body.waiveFee === true ? 1 : 0;

    const hadCommuteFee = (existing.commute_fee || 0) > 0;
    const wouldKeepTravelFee = hadCommuteFee && (mins < TRAVEL_FEE_CUTOFF_MINUTES || noShow);
    travelFeeKept = wouldKeepTravelFee && body.waiveTravelFee !== true;
    newCommuteFee = travelFeeKept ? existing.commute_fee : 0;
    preCommuteFee = travelFeeKept ? null : (hadCommuteFee ? existing.commute_fee : null);
    // Same bookkeeping convention as feeWaived above: recorded only when
    // there was actually a travel fee to waive, so the dashboard can tell
    // "deliberately waived" apart from "never applied in the first place".
    travelFeeWaived = wouldKeepTravelFee && body.waiveTravelFee === true ? 1 : 0;
  } else if (reactivating) {
    newPrice = existing.pre_cancellation_price != null ? existing.pre_cancellation_price : existing.price;
    prePrice = null;
    feeWaived = 0;
    newCommuteFee = existing.pre_cancellation_commute_fee != null ? existing.pre_cancellation_commute_fee : existing.commute_fee;
    preCommuteFee = null;
    travelFeeWaived = 0;
  }

  // Cancelling always clears any payment-pending/paid state to
  // "not_applicable", UNLESS a late fee was just applied, in which case the
  // fee amount is owed and payment_status becomes "pending" like any other
  // unpaid charge. Reactivating (confirming/completing a previously-
  // cancelled booking) puts it back to "pending" -- its prior paid/pending
  // state before the cancellation isn't tracked, so this is the safer
  // default for an admin to then re-mark as paid if it actually was.
  await env.DB.prepare(
    `UPDATE bookings SET status = ?, cancelled_at = ?, cancellation_reason = ?, payment_status = ?, paid_at = ?, price = ?, pre_cancellation_price = ?, cancellation_fee_waived = ?, commute_fee = ?, pre_cancellation_commute_fee = ?, no_show = ?, travel_fee_waived = ? WHERE id = ?`
  )
    .bind(
      body.status,
      cancelling ? new Date().toISOString().replace("Z", "") : reactivating ? null : existing.cancelled_at,
      cancelling ? reason : reactivating ? null : existing.cancellation_reason,
      cancelling ? (lateFeeApplied || travelFeeKept ? "pending" : "not_applicable") : reactivating ? "pending" : existing.payment_status,
      cancelling ? null : reactivating ? null : existing.paid_at,
      newPrice,
      prePrice,
      feeWaived,
      newCommuteFee,
      preCommuteFee,
      cancelling ? (noShow ? 1 : 0) : reactivating ? 0 : existing.no_show,
      travelFeeWaived,
      id
    )
    .run();

  // Re-confirming (setting a cancelled or completed booking back to
  // "confirmed") is treated like the original booking-confirmation email:
  // the customer gets the same confirmation email, with both PDFs
  // attached, as when they first booked.
  const reconfirming = body.status === "confirmed" && existing.status !== "confirmed";

  if (existing.status !== body.status) {
    const action = cancelling ? (noShow ? "no_show" : "cancelled") : body.status === "completed" ? "completed" : body.status === "processing" ? "processing" : reconfirming ? "reconfirmed" : "status_changed";
    const feeDetail = cancelling
      ? lateFeeApplied
        ? ` — late cancellation fee of €${lateFeeAmount} applied (was €${existing.price})`
        : lateFeeAmount > 0 && feeWaived
          ? ` — late cancellation fee waived (would have been €${lateFeeAmount})`
          : ""
      : "";
    const travelFeeDetail = cancelling && (existing.commute_fee || 0) > 0
      ? travelFeeKept
        ? ` — travel fee of €${existing.commute_fee} charged`
        : travelFeeWaived
          ? ` — travel fee of €${existing.commute_fee} waived`
          : ""
      : "";
    const detail = cancelling
      ? `${noShow ? "Marked as no-show" : "Cancelled"} by admin${reason ? ` (reason: ${reason})` : ""}${feeDetail}${travelFeeDetail}`
      : `Status changed: ${existing.status} → ${body.status}`;
    await logActivity(env, id, action, "admin", detail);
  }

  let emailSent = false;
  if (cancelling && body.notifyCustomer !== false) {
    emailSent = (
      await sendCancellationEmail(
        env,
        { ...existing, cancellation_reason: reason, price: newPrice, pre_cancellation_price: prePrice, commute_fee: newCommuteFee, pre_cancellation_commute_fee: preCommuteFee, no_show: noShow ? 1 : 0 },
        body.lang === "en" ? "en" : "de",
        { cancelledBy: "admin" }
      )
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

  return json({
    ok: true,
    id,
    status: body.status,
    emailSent,
    lateFeeApplied,
    lateFeeAmount: lateFeeApplied ? lateFeeAmount : 0,
    travelFeeKept,
    travelFeeAmount: travelFeeKept ? newCommuteFee : 0,
    noShow,
  });
}

// Lets an admin waive an already-applied late-cancellation fee, at any
// later point -- regardless of whether the cancellation that triggered it
// was done by the admin or was a customer self-service cancellation (the
// customer-facing cancel page has no equivalent option; only an admin can
// grant this). Restores the fee amount to 0 while keeping
// pre_cancellation_price as the historical record of what the original
// service price was, and marks cancellation_fee_waived so the dashboard can
// show that this was a deliberate waiver rather than the booking simply
// never having owed a fee.
export async function handleAdminWaiveCancellationFee(request, env, id) {
  if (!hasAdminHeader(request)) return json({ error: "Bad request" }, 400);
  const existing = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404);
  if (existing.pre_cancellation_price == null) {
    return json({ error: "This booking has no late-cancellation fee to waive" }, 400);
  }
  if (existing.cancellation_fee_waived) {
    return json({ error: "This fee has already been waived" }, 400);
  }
  const waivedAmount = existing.price;
  await env.DB.prepare(
    `UPDATE bookings SET price = 0, cancellation_fee_waived = 1, payment_status = 'not_applicable', paid_at = NULL WHERE id = ?`
  )
    .bind(id)
    .run();
  await logActivity(env, id, "cancellation_fee_waived", "admin", `Waived late cancellation fee of €${waivedAmount}`);
  return json({ ok: true, id, waivedAmount });
}

const TIME_RE = /^\d{2}:\d{2}$/;

// Lets an admin move a confirmed/processing booking to a new date and/or
// time. Unlike the customer-facing booking flow, this doesn't enforce the
// 2-hour booking-lead buffer (an admin may need to move something to very
// soon), but it still checks for a double-booking against other confirmed
// appointments and against the admin's own calendar blocks, using the exact
// same conflict logic as the public booking endpoint (see
// bookingBlocksSlot/loadBlockedChecker in src/index.js) so two bookings can
// never silently overlap.
export async function handleAdminRescheduleBooking(request, env, id) {
  if (!hasAdminHeader(request)) return json({ error: "Bad request" }, 400);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  const date = typeof body?.date === "string" ? body.date : "";
  const time = typeof body?.time === "string" ? body.time : "";
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) {
    return json({ error: "Please provide a valid date and time" }, 400);
  }

  const existing = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404);
  if (existing.status === "cancelled" || existing.status === "completed") {
    return json({ error: "Only a confirmed or in-progress booking can be rescheduled" }, 400);
  }

  const now = berlinNow();
  if (date < now.date || (date === now.date && toMinutes(time) < now.minutes)) {
    return json({ error: "Please choose a date and time in the future" }, 400);
  }

  const start = toMinutes(time);
  const end = start + (existing.duration_minutes || 0);
  const { results: conflicts } = await env.DB.prepare(
    `SELECT time, duration_minutes FROM bookings WHERE date = ? AND status = 'confirmed' AND id != ?`
  )
    .bind(date, id)
    .all();
  const clash = conflicts.some((b) => bookingBlocksSlot(start, end, toMinutes(b.time)));
  if (clash) {
    return json({ error: "This slot conflicts with another confirmed booking" }, 409);
  }
  const isBlocked = await loadBlockedChecker(env, date);
  if (isBlocked(start)) {
    return json({ error: "This slot is blocked on the calendar" }, 409);
  }

  const oldDate = existing.date;
  const oldTime = existing.time;
  if (oldDate === date && oldTime === time) {
    return json({ error: "That is already this booking's date and time" }, 400);
  }

  await env.DB.prepare(`UPDATE bookings SET date = ?, time = ? WHERE id = ?`).bind(date, time, id).run();
  await logActivity(
    env,
    id,
    "rescheduled",
    "admin",
    `Rescheduled from ${oldDate} ${oldTime} to ${date} ${time}`
  );

  let emailSent = false;
  if (body.notifyCustomer !== false) {
    const lang = body.lang === "en" ? "en" : "de";
    const [audience, categoryId, ...path] = (existing.service_id || "").split(":");
    const resolved = audience && categoryId ? resolveLeaf(catalog, audience, categoryId, path) : null;
    if (resolved) {
      const bookingRef = `ZTL-${existing.id.split("-")[0].toUpperCase()}`;
      const quantity = existing.quantity || 1;
      const bookingForEmail = {
        id: existing.id,
        bookingRef,
        breadcrumbDe: fullBreadcrumb(resolved, audience, "de"),
        breadcrumbEn: fullBreadcrumb(resolved, audience, "en"),
        date,
        time,
        customer_name: existing.customer_name,
        customer_email: existing.customer_email,
        customer_address: existing.customer_address,
        commuteFee: existing.commute_fee || 0,
        onlineConsultation: !!existing.online_consultation,
        liabilityAcceptedAt: existing.liability_accepted_at,
        privacyAcceptedAt: existing.privacy_accepted_at,
      };
      const serviceForEmail = {
        duration: existing.duration_minutes,
        price: resolved.leaf.quote ? null : existing.price,
        quote: !!resolved.leaf.quote,
        quoteKind: resolved.leaf.quoteKind || null,
        isConsultation: resolved.leaf.quoteKind === "consultation",
        quantity,
        unitPrice: resolved.leaf.quote ? null : Math.round((existing.price / quantity) * 100) / 100,
      };
      emailSent = (
        await sendConfirmationEmail(env, bookingForEmail, serviceForEmail, lang, {
          rescheduled: { oldDate, oldTime },
        })
      ).sent;
    }
  }

  return json({ ok: true, id, date, time, emailSent });
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

  await logActivity(env, id, "payment_status_changed", "admin", `Payment status changed to ${body.paymentStatus}`);
  return json({ ok: true, id, paymentStatus: body.paymentStatus });
}

// Quote-type bookings (consultation, or "price given on-site") are stored
// with price = 0 -- the real price is only known once the admin has
// actually diagnosed the job or held the consultation. This lets them key
// that final price in afterwards; the dashboard's "€X" display and the
// invoice/payment-link emails all just read the same `price` column, so
// nothing else needs to change once it's set.
const MAX_MANUAL_PRICE = 100000;

export async function handleAdminSetPrice(request, env, id) {
  if (!hasAdminHeader(request)) return json({ error: "Bad request" }, 400);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  const price = Number(body?.price);
  if (!Number.isFinite(price) || price < 0 || price > MAX_MANUAL_PRICE) {
    return json({ error: "Invalid price" }, 400);
  }
  const existing = await env.DB.prepare(`SELECT id FROM bookings WHERE id = ?`).bind(id).first();
  if (!existing) return json({ error: "Not found" }, 404);

  // Prices are whole euros throughout the app (bookings.price is an
  // INTEGER column, and every display just shows "€" + the number with no
  // decimal formatting), so round here rather than storing cents nothing
  // else would ever show.
  const rounded = Math.round(price);
  await env.DB.prepare(`UPDATE bookings SET price = ? WHERE id = ?`).bind(rounded, id).run();
  await logActivity(env, id, "price_set", "admin", `Price set to €${rounded}`);
  return json({ ok: true, id, price: rounded });
}

// ---- Manual orders (admin-created, linked back to an existing booking) --
//
// For a consultation/quote booking: once the admin has actually visited or
// spoken with the customer and agreed a price, this lets them record that
// as its own booking-shaped row -- any person or company, any catalog
// service, free-text notes, and a price they set themselves -- rather than
// trying to force the original quote booking's price to represent it.
// Reuses the bookings table itself (created_by = 'admin', source_booking_id
// pointing back at the original), so the resulting order immediately gets
// the same status/payment/invoice/payment-link tooling as a real booking.

let cachedCatalogLeaves = null;
function getCatalogLeaves() {
  if (!cachedCatalogLeaves) cachedCatalogLeaves = listCatalogLeaves(catalog);
  return cachedCatalogLeaves;
}

export async function handleAdminCatalogLeaves() {
  return json({ leaves: getCatalogLeaves() });
}

export async function handleAdminListOrders(env, bookingId) {
  const { results } = await env.DB.prepare(
    `SELECT id, service_name, price, status, payment_status, created_at FROM bookings WHERE source_booking_id = ? ORDER BY created_at DESC`
  )
    .bind(bookingId)
    .all();
  return json({ orders: results.map((r) => ({ ...r, bookingRef: `ZTL-${r.id.split("-")[0].toUpperCase()}` })) });
}

export async function handleAdminCreateOrder(request, env, sourceId) {
  if (!hasAdminHeader(request)) return json({ error: "Bad request" }, 400);
  const source = await env.DB.prepare(`SELECT * FROM bookings WHERE id = ?`).bind(sourceId).first();
  if (!source) return json({ error: "Not found" }, 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }

  const serviceId = typeof body?.serviceId === "string" ? body.serviceId : "";
  const [audience, categoryId, ...path] = serviceId.split(":");
  const resolved = audience && categoryId ? resolveLeaf(catalog, audience, categoryId, path) : null;
  if (!resolved) return json({ error: "Invalid service" }, 400);

  const price = Number(body?.price);
  if (!Number.isFinite(price) || price < 0 || price > MAX_MANUAL_PRICE) {
    return json({ error: "Invalid price" }, 400);
  }

  const firstName = typeof body?.firstName === "string" ? body.firstName.trim().slice(0, 100) : "";
  const lastName = typeof body?.lastName === "string" ? body.lastName.trim().slice(0, 100) : "";
  if (!firstName || !lastName) return json({ error: "First and last name are required" }, 400);
  const customerName = `${firstName} ${lastName}`.trim();
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!isValidEmail(email)) return json({ error: "Invalid email address" }, 400);
  const company = typeof body?.company === "string" ? body.company.trim().slice(0, 200) || null : null;
  const phone = typeof body?.phone === "string" ? body.phone.trim().slice(0, 50) || null : null;
  const address = typeof body?.address === "string" ? body.address.trim().slice(0, 300) : "";
  const notes = typeof body?.notes === "string" ? body.notes.trim().slice(0, 1000) || null : null;
  const quantity = Number.isInteger(body?.quantity) && body.quantity > 0 && body.quantity <= 100 ? body.quantity : 1;

  const id = crypto.randomUUID();
  const serviceIdStr = `${audience}:${categoryId}:${(path || []).join(":")}`;
  const serviceName = localizedBreadcrumbNameSafe(resolved);

  try {
    await env.DB.prepare(
      `INSERT INTO bookings (id, service_id, service_name, price, duration_minutes, date, time, customer_name, customer_first_name, customer_last_name, customer_email, customer_phone, customer_company, customer_address, notes, status, payment_status, quantity, source_booking_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'pending', ?, ?, 'admin')`
    )
      .bind(
        id,
        serviceIdStr,
        serviceName,
        Math.round(price),
        resolved.leaf.duration || 0,
        source.date,
        source.time,
        customerName,
        firstName,
        lastName,
        email,
        phone,
        company,
        address || source.customer_address || "",
        notes,
        quantity,
        sourceId
      )
      .run();
  } catch (err) {
    // Surfaced as a real error message rather than a bare 500 -- a D1
    // failure here (bad bind count, a since-dropped column, etc.) should
    // tell the admin something useful instead of the generic fallback.
    return json({ error: `Could not create order: ${err.message || err}` }, 500);
  }

  const bookingRef = `ZTL-${id.split("-")[0].toUpperCase()}`;
  const sourceRef = `ZTL-${source.id.split("-")[0].toUpperCase()}`;
  await logActivity(env, id, "created", "admin", `Manually created order linked to ${sourceRef}`);
  await logActivity(env, sourceId, "order_created", "admin", `Created order ${bookingRef} (€${Math.round(price)})`);

  return json({ ok: true, id, bookingRef });
}

// Small local fallback so a catalog leaf with no `name` of its own (the
// common case -- the display name normally comes from the breadcrumb option
// that led to it) still gets a sensible service_name on the new row.
function localizedBreadcrumbNameSafe(resolved) {
  if (resolved.leaf.name) return resolved.leaf.name.de || resolved.leaf.name.en;
  const last = resolved.breadcrumb[resolved.breadcrumb.length - 1];
  return last ? last.de || last.en : "Service";
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
  await logActivity(env, id, "invoice_sent", "admin", result.sent ? "Invoice emailed to customer" : "Invoice send attempted but not emailed");
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

  // Optional: send to a different address than the one on the booking --
  // e.g. the customer who booked doesn't have access to that inbox and
  // asked for the link to go elsewhere instead.
  const overrideEmail = typeof body?.email === "string" ? body.email.trim() : "";
  if (overrideEmail && !isValidEmail(overrideEmail)) {
    return json({ error: "Invalid email address" }, 400);
  }

  const lang = body?.lang === "en" ? "en" : "de";
  const result = await sendPaymentLinkEmail(env, existing, lang, overrideEmail || null);
  await logActivity(env, id, "payment_link_sent", "admin", result.sent ? `Payment link emailed${overrideEmail ? ` to ${overrideEmail}` : ""}` : "Payment link send attempted but not emailed");
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
