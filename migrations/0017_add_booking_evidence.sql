-- Optional evidence photos an admin can attach to a booking after the
-- fact -- e.g. a picture of the device/equipment before work starts, taken
-- with the customer's permission. Separate from the customer's own
-- booking-time attachment_* columns on `bookings` (a single photo
-- submitted with the booking itself): this is admin-added, any number of
-- photos per booking, each with its own timestamp and a short note.
--
-- Run against the already-deployed production database the same way
-- migrations/0001-0016 were run:
--   wrangler d1 execute zettly-db --remote --file=./migrations/0017_add_booking_evidence.sql

CREATE TABLE IF NOT EXISTS booking_evidence (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  image_data TEXT NOT NULL,       -- base64-encoded, no data: prefix
  content_type TEXT NOT NULL,
  filename TEXT,
  note TEXT,                      -- short optional note about the photo
  created_at TEXT NOT NULL DEFAULT (datetime('now')),  -- the date/time stamp shown with the photo
  created_by TEXT                 -- reserved for a future multi-admin-user setup; unused today
);

CREATE INDEX IF NOT EXISTS idx_booking_evidence_booking_id ON booking_evidence(booking_id);
