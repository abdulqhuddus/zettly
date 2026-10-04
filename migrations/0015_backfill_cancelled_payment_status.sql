-- 0014 added payment_status with a blanket DEFAULT 'pending', which also
-- landed on bookings that were already cancelled before this column
-- existed. A cancelled booking's payment status should read
-- "not_applicable" (nothing owed, nothing to collect), so this backfills
-- every existing cancelled row -- newly cancelled bookings get this
-- automatically going forward via the admin/cancel endpoints.
--
-- Run against the already-deployed production database the same way
-- migrations/0001-0014 were run:
--   wrangler d1 execute zettly-db --remote --file=./migrations/0015_backfill_cancelled_payment_status.sql

UPDATE bookings SET payment_status = 'not_applicable', paid_at = NULL WHERE status = 'cancelled';
