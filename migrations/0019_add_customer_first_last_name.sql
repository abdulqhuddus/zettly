-- The booking form always collects first/last name as two separate fields,
-- but only their concatenation was ever stored (customer_name) -- so the
-- admin dashboard had to guess the split back apart later (first word vs.
-- the rest), which gets compound first names like "Abdul Qhuddus" wrong.
-- Storing both parts as given fixes that at the source.
--
-- Existing rows are backfilled with the same best-effort split the admin
-- dashboard used to do client-side (first word / remainder) since the
-- original two-field input is gone for those -- only new bookings (made
-- after src/index.js and index.html send firstName/lastName explicitly)
-- get an exact split.
--
-- Run against production with:
--   wrangler d1 execute zettly-db --remote --file=migrations/0019_add_customer_first_last_name.sql

ALTER TABLE bookings ADD COLUMN customer_first_name TEXT;
ALTER TABLE bookings ADD COLUMN customer_last_name TEXT;

UPDATE bookings
SET
  customer_first_name = CASE WHEN instr(customer_name, ' ') > 0 THEN substr(customer_name, 1, instr(customer_name, ' ') - 1) ELSE customer_name END,
  customer_last_name = CASE WHEN instr(customer_name, ' ') > 0 THEN substr(customer_name, instr(customer_name, ' ') + 1) ELSE '' END
WHERE customer_first_name IS NULL;
