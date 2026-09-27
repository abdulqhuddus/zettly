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
  status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | cancelled
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
