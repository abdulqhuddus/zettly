-- Lets a customer optionally attach a photo (e.g. of the device or issue)
-- on the final booking step, so the technician can see it ahead of the
-- appointment. Stored inline in the row as base64 rather than in a separate
-- object store (R2 isn't enabled on this account yet) -- the booking form
-- caps the original file at ~1.2MB before encoding, which keeps the whole
-- row comfortably under D1's 2,000,000-byte row-size limit even with
-- base64's ~37% overhead.
--
-- Run against the already-deployed production database the same way
-- migrations/0001-0010 were run:
--   wrangler d1 execute zettly-db --remote --file=./migrations/0011_add_booking_attachment.sql

ALTER TABLE bookings ADD COLUMN attachment_data TEXT;
ALTER TABLE bookings ADD COLUMN attachment_filename TEXT;
ALTER TABLE bookings ADD COLUMN attachment_content_type TEXT;
ALTER TABLE bookings ADD COLUMN attachment_size INTEGER;
