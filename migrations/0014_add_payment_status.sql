-- Adds payment tracking to bookings, separate from the booking status
-- (confirmed/cancelled/completed). payment_status is either 'paid' or
-- 'pending' -- today it's only ever set manually by an admin ("Mark as
-- paid"/"Mark as pending" in the dashboard), but the column is generic so a
-- future payment-gateway webhook can flip it to 'paid' automatically on a
-- successful online payment without any further schema change.
--
-- Run against the already-deployed production database the same way
-- migrations/0001-0013 were run:
--   wrangler d1 execute zettly-db --remote --file=./migrations/0014_add_payment_status.sql

ALTER TABLE bookings ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE bookings ADD COLUMN paid_at TEXT;
