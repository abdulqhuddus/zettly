-- Adds the customer's visit address, collected on the booking form so the
-- technician knows where to go for on-site appointments.
-- Run this once against the already-deployed database with:
--   wrangler d1 execute zettly-db --remote --file=./migrations/0001_add_customer_address.sql

ALTER TABLE bookings ADD COLUMN customer_address TEXT NOT NULL DEFAULT '';
