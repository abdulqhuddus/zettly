-- Records when a booking was cancelled (set by both the admin panel and the
-- customer self-service cancellation page). Run against the already-deployed
-- production database the same way migrations/0001 and 0002 were run:
--   wrangler d1 execute zettly-db --remote --file=./migrations/0003_add_cancelled_at.sql

ALTER TABLE bookings ADD COLUMN cancelled_at TEXT;
