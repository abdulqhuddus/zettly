-- Records the distance-based call-out (Anfahrt) fee charged on a booking,
-- and the straight-line distance (km) from Munich that it was computed
-- from, so the admin panel and revenue stats can see the breakdown rather
-- than just an already-merged price. Run against the already-deployed
-- production database the same way migrations/0001-0004 were run:
--   wrangler d1 execute zettly-db --remote --file=./migrations/0005_add_commute_fee.sql

ALTER TABLE bookings ADD COLUMN commute_fee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN commute_distance_km REAL;
