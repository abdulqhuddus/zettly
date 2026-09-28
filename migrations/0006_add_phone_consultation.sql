-- Records whether the customer asked for a consultation-type booking to be
-- held over the phone instead of in person (offered as an optional checkbox
-- on the booking form for leaves flagged "phoneOptional" in catalog.json,
-- currently just the Dynamics 365 consultation). Run against the
-- already-deployed production database the same way migrations/0001-0005
-- were run:
--   wrangler d1 execute zettly-db --remote --file=./migrations/0006_add_phone_consultation.sql

ALTER TABLE bookings ADD COLUMN phone_consultation INTEGER NOT NULL DEFAULT 0;
