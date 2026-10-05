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
  customer_first_name TEXT,     -- as entered on the two-field booking form; customer_name is still the source of truth for display elsewhere (emails, PDFs)
  customer_last_name TEXT,
  customer_email TEXT NOT NULL,
  customer_phone TEXT,
  customer_company TEXT,                     -- optional, business bookings only
  customer_address TEXT NOT NULL DEFAULT '', -- on-site visit address
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | cancelled | completed
  payment_status TEXT NOT NULL DEFAULT 'pending', -- paid | pending | not_applicable (auto-set when status becomes 'cancelled') -- independent of `status` otherwise; set manually today, by a payment-gateway webhook once that's wired up
  paid_at TEXT,                  -- set when payment_status becomes 'paid'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at TEXT,            -- set when status becomes 'cancelled'
  cancellation_reason TEXT,     -- required whenever status becomes 'cancelled'
  commute_fee INTEGER NOT NULL DEFAULT 0,  -- distance-based call-out fee (separate from `price`, the service fee)
  commute_distance_km REAL,     -- straight-line km from Munich the fee was computed from
  online_consultation INTEGER NOT NULL DEFAULT 0, -- 1 if the customer asked for a consultation-type booking to be held online (video call) instead of in person
  liability_accepted_at TEXT,   -- set at booking time; the UI can't submit without accepting the liability notices
  privacy_accepted_at TEXT,     -- set at booking time; the UI can't submit without accepting the privacy policy (#f-consent)
  quantity INTEGER NOT NULL DEFAULT 1,  -- devices/units covered; `price` already includes this multiplier, the call-out fee never does
  attachment_data TEXT,         -- optional customer-provided photo, base64-encoded (no data: prefix); capped well under D1's 2MB row limit
  attachment_filename TEXT,
  attachment_content_type TEXT,
  attachment_size INTEGER,      -- original (pre-base64) byte size, for display only
  source_booking_id TEXT REFERENCES bookings(id), -- set when this row is a manually-created order linked back to the consultation/quote booking it followed up on
  created_by TEXT NOT NULL DEFAULT 'customer', -- 'customer' | 'admin' -- 'admin' rows are manual orders created from the dashboard, not a real self-service booking
  pre_cancellation_price INTEGER, -- the service price before a late-cancellation fee overwrote `price`; NULL unless a fee was ever applied (see migrations/0021)
  cancellation_fee_waived INTEGER NOT NULL DEFAULT 0 -- 1 if an admin waived an applicable late-cancellation fee
);

CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);
CREATE INDEX IF NOT EXISTS idx_bookings_source_booking_id ON bookings(source_booking_id);

-- Optional evidence photos an admin attaches to a booking after the fact
-- (e.g. the device/equipment before work starts, with the customer's
-- permission) -- any number per booking, each with its own timestamp and a
-- short note. Separate from the customer's own booking-time attachment_*
-- columns above.
CREATE TABLE IF NOT EXISTS booking_evidence (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  image_data TEXT NOT NULL,
  content_type TEXT NOT NULL,
  filename TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_booking_evidence_booking_id ON booking_evidence(booking_id);

-- Timeline of everything that happens to a booking after it's created --
-- status changes, payment status changes, evidence photos added/removed,
-- invoices/payment links sent, and the customer's own booking-time
-- attachment. Shown on the admin dashboard's "View logs" page per booking.
CREATE TABLE IF NOT EXISTS booking_activity_log (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  action TEXT NOT NULL,     -- short machine-readable key, e.g. 'status_changed', 'payment_status_changed'
  actor TEXT NOT NULL,      -- 'admin' | 'customer' | 'system'
  detail TEXT,              -- short human-readable description, e.g. "confirmed → cancelled"
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_booking_activity_log_booking_id ON booking_activity_log(booking_id);

-- Tracks failed admin login attempts per IP so the login endpoint can lock
-- out an IP after repeated failures instead of allowing unlimited guesses.
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  ip TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,          -- ISO datetime; NULL/past = not locked
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Admin-managed calendar blocks: one row per blocked date (a multi-day block
-- is exploded into one row per day at creation time), each carrying whether
-- the whole day, just the morning, or just the afternoon is blocked.
CREATE TABLE IF NOT EXISTS calendar_blocks (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL, -- YYYY-MM-DD
  period TEXT NOT NULL CHECK (period IN ('full', 'am', 'pm')),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calendar_blocks_date ON calendar_blocks(date);

-- Generic key/value settings. Currently just "bookings_enabled" ('0'/'1'),
-- a single global switch to pause all new bookings with no end date,
-- separate from the date-scoped calendar_blocks above.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
