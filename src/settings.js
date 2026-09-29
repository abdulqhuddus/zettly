// A tiny key/value settings store (see migrations/0008_add_settings.sql),
// shared between the public booking flow (src/index.js) and the admin API
// (src/admin.js) so there's exactly one place that knows how the "bookings
// enabled" switches are read and written.
//
// There are two independent switches — one for "home" bookings, one for
// "business" bookings — so the owner can pause, say, all business work
// without also turning away home customers, or the other way around.

export const BOOKING_AUDIENCES = ["home", "business"];

function keyFor(audience) {
  return `bookings_enabled_${audience}`;
}

// Missing row = enabled. This matters for the very first deploy after the
// migration runs, before anyone has touched either toggle: the site should
// keep accepting bookings by default, not silently go dark.
export async function isBookingEnabled(env, audience) {
  if (!env.DB || !BOOKING_AUDIENCES.includes(audience)) return true;
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(keyFor(audience)).first();
  return row ? row.value === "1" : true;
}

export async function setBookingEnabled(env, audience, enabled) {
  if (!BOOKING_AUDIENCES.includes(audience)) throw new Error("Invalid audience");
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(keyFor(audience), enabled ? "1" : "0")
    .run();
}

// Both switches at once, for the admin dashboard and the public status
// check alike.
export async function getBookingStatuses(env) {
  const [home, business] = await Promise.all([isBookingEnabled(env, "home"), isBookingEnabled(env, "business")]);
  return { home, business };
}
