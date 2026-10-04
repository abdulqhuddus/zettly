-- Lets an admin manually create a priced "order" linked back to an existing
-- (usually consultation/quote) booking -- e.g. after visiting a customer and
-- agreeing a price in person. Stored as an ordinary row in `bookings` (so it
-- gets the same status/payment/invoice/payment-link machinery for free),
-- distinguished from a real self-service booking by created_by = 'admin'
-- and linked to its originating booking via source_booking_id.
--
-- Run against production with:
--   wrangler d1 execute zettly-db --remote --file=migrations/0020_add_manual_orders.sql

ALTER TABLE bookings ADD COLUMN source_booking_id TEXT REFERENCES bookings(id);
ALTER TABLE bookings ADD COLUMN created_by TEXT NOT NULL DEFAULT 'customer';

CREATE INDEX IF NOT EXISTS idx_bookings_source_booking_id ON bookings(source_booking_id);
