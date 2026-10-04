-- Adds a timeline of everything that happens to a booking after it's
-- created: who cancelled it (customer vs. admin), status changes, payment
-- status changes, evidence photos added/removed, invoices and payment links
-- sent, and the customer's own booking-time attachment. Shown on the admin
-- dashboard's new "View logs" page per booking.
--
-- Run against production with:
--   wrangler d1 execute zettly-db --remote --file=migrations/0018_add_booking_activity_log.sql

CREATE TABLE IF NOT EXISTS booking_activity_log (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  action TEXT NOT NULL,     -- short machine-readable key, e.g. 'status_changed', 'payment_status_changed'
  actor TEXT NOT NULL,      -- 'admin' | 'customer' | 'system'
  detail TEXT,              -- short human-readable description, e.g. "confirmed → cancelled"
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_booking_activity_log_booking_id ON booking_activity_log(booking_id);
