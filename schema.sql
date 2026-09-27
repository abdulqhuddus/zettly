-- Zettly booking schema (Cloudflare D1)

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
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | cancelled
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
