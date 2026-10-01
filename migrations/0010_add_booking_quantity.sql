-- How many devices/units a booking covers. The customer sets this on the
-- final details step (default 1); only the service price scales with it --
-- the call-out fee stays a flat per-visit charge regardless of quantity, so
-- it is never multiplied anywhere this column is used.
--
-- `price` already stores the quantity-multiplied total (quantity * the
-- catalog's per-unit price), exactly as it always stored the full price for
-- a single device, so no other pricing columns change meaning -- this
-- column exists purely so receipts/PDFs/admin can show "x2" rather than a
-- number that silently became ambiguous.
--
-- Run against the already-deployed production database the same way
-- migrations/0001-0009 were run:
--   wrangler d1 execute zettly-db --remote --file=./migrations/0010_add_booking_quantity.sql

ALTER TABLE bookings ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;
