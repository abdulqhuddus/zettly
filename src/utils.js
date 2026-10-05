// Small helpers shared across src/index.js, src/admin.js and src/cancel.js —
// kept in one place so nothing gets duplicated (or drifts) between them.

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Current wall-clock date/time in Europe/Berlin, independent of the
// runtime's own timezone.
export function berlinNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  // hour12:false can yield "24" for midnight; normalize to 0.
  const hour = map.hour === "24" ? 0 : parseInt(map.hour, 10);
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    minutes: hour * 60 + parseInt(map.minute, 10),
  };
}

// Minutes between "now" (Europe/Berlin) and a given date+time (also
// interpreted as Europe/Berlin wall-clock), for cancellation-window checks.
export function minutesUntil(date, time) {
  const now = berlinNow();
  const nowTotal = dateToDayIndex(now.date) * 1440 + now.minutes;
  const apptTotal = dateToDayIndex(date) * 1440 + toMinutes(time);
  return apptTotal - nowTotal;
}

// How close to the appointment a cancellation counts as "late" and the fee
// below applies -- shared by src/cancel.js (customer self-service) and
// src/admin.js (admin-triggered cancellation) so both enforce the exact same
// window.
export const LATE_CANCEL_CUTOFF_MINUTES = 24 * 60;

// The late-cancellation fee is 50% of the service price, but never more than
// this many euros -- e.g. a €200 booking owes €50 (capped), a €60 booking
// owes €30 (uncapped).
export const LATE_CANCEL_FEE_CAP = 50;

// 50% of price, capped at LATE_CANCEL_FEE_CAP, kept exact to the cent
// (e.g. a €39 booking owes €19.50, not rounded up to €20). Returns 0 for a
// quote/consultation booking (price 0 or not yet set) -- there's nothing to
// charge a percentage of until a real price exists.
export function computeLateCancellationFee(price) {
  const p = Number(price) || 0;
  if (p <= 0) return 0;
  const half = Math.round(p * 50) / 100; // exact to the cent, no float drift
  return Math.min(half, LATE_CANCEL_FEE_CAP);
}

// How close to the appointment a cancellation (or a no-show, which by
// definition happens at/after the appointment time) must be for an
// already-assessed travel/commute fee to be kept rather than waived. This is
// a separate, tighter window than LATE_CANCEL_CUTOFF_MINUTES above -- a
// booking cancelled, say, 10 hours out still owes the 24h service-price late
// fee but is NOT close enough to the appointment to keep the travel fee.
export const TRAVEL_FEE_CUTOFF_MINUTES = 3 * 60;

function dateToDayIndex(dateStr) {
  // Days since epoch for a YYYY-MM-DD string, treated as a plain calendar
  // date (no timezone conversion) so it composes with berlinNow()'s
  // already-Berlin-local date string.
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Records one entry in a booking's activity timeline (see the admin "View
// logs" page). Best-effort: a logging failure must never break the actual
// action it's describing, so it's swallowed here rather than propagated.
export async function logActivity(env, bookingId, action, actor, detail = null) {
  try {
    await env.DB.prepare(
      `INSERT INTO booking_activity_log (id, booking_id, action, actor, detail) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(crypto.randomUUID(), bookingId, action, actor, detail)
      .run();
  } catch {
    // ignore -- the timeline is a convenience view, not the record of truth
  }
}

export function localizedDate(dateStr, lang) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(lang === "en" ? "en-GB" : "de-DE", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}
