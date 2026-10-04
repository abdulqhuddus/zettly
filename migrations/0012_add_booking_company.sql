-- Lets a business customer optionally give their company name on the final
-- booking step, shown to staff in the admin panel and the owner's booking
-- notification email. Only ever populated for audience = 'business'.
--
-- Run against the already-deployed production database the same way
-- migrations/0001-0011 were run:
--   wrangler d1 execute zettly-db --remote --file=./migrations/0012_add_booking_company.sql

ALTER TABLE bookings ADD COLUMN customer_company TEXT;
