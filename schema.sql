-- Zettly booking schema (Cloudflare D1)
--
-- For a database created before customer_address existed, run the migration
-- in ./migrations/ instead of re-running this file (D1/SQLite errors on
-- CREATE TABLE IF NOT EXISTS + a changed column list against an existing
-- table's on-disk schema being different is fine, but the new column won't
-- retroactively appear on old rows without that migration).

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  price INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL,
  date TEXT NOT NULL,        -- YYYY-MM-DD
  time TEXT NOT NULL,        -- HH:MM (24h)
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  customer_address TEXT NOT NULL DEFAULT '', -- on-site visit address
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | cancelled | completed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT,            -- set when status becomes 'cancelled'
  cancellation_reason TEXT      -- required whenever status becomes 'cancelled'
);

CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);

-- Tracks failed admin login attempts per IP so the login endpoint can lock
-- out an IP after repeated failures instead of allowing unlimited guesses.
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  ip TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,          -- ISO datetime; NULL/past = not locked
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
