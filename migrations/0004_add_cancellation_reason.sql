-- Records why a booking was cancelled (mandatory going forward, entered by
-- either staff in the admin panel or the customer on the self-service
-- cancellation page). Run against the already-deployed production database
-- the same way migrations/0001-0003 were run:
--   wrangler d1 execute zettly-db --remote --file=./migrations/0004_add_cancellation_reason.sql

ALTER TABLE bookings ADD COLUMN cancellation_reason TEXT;
