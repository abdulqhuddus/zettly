// A tiny key/value settings store (see migrations/0008_add_settings.sql),
// shared between the public booking flow (src/index.js) and the admin API
// (src/admin.js) so there's exactly one place that knows how the global
// "bookings enabled" switch is read and written.

const BOOKINGS_ENABLED_KEY = "bookings_enabled";

// Missing row = enabled. This matters for the very first deploy after the
// migration runs, before anyone has touched the toggle: the site should
// keep accepting bookings by default, not silently go dark.
export async function isBookingEnabled(env) {
  if (!env.DB) return true;
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind(BOOKINGS_ENABLED_KEY).first();
  return row ? row.value === "1" : true;
}

export async function setBookingEnabled(env, enabled) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
    .bind(BOOKINGS_ENABLED_KEY, enabled ? "1" : "0")
    .run();
}
