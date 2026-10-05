-- Late-cancellation fee tracking: a booking cancelled less than 24h before
-- its appointment owes 50% of its price (capped at a fixed maximum, see
-- LATE_CANCEL_FEE_CAP in src/utils.js). When that fee is applied, the
-- booking's `price` column is overwritten to the fee amount (so the rest of
-- the app -- payment status, invoices, payment links -- keeps working
-- unchanged against "what's actually owed"), and the original price is kept
-- here so it's never lost.
ALTER TABLE bookings ADD COLUMN pre_cancellation_price INTEGER; -- the service price before a late-cancellation fee overwrote it; NULL unless a fee was ever applied to this booking
ALTER TABLE bookings ADD COLUMN cancellation_fee_waived INTEGER NOT NULL DEFAULT 0; -- 1 if an admin waived an applicable late-cancellation fee (customer owes nothing, even though the cancellation was late)
