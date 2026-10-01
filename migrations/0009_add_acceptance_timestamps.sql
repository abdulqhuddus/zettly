-- Records when the customer accepted the liability notices and the privacy
-- policy during booking. The booking form gates the submit button on both
-- checkboxes being checked (state.liabilityAccepted + the #f-consent
-- checkbox), but those flags were previously only front-end state that
-- never reached the backend, so nothing proved the acceptance after the
-- fact. Both columns are set to the booking's own created_at timestamp at
-- insert time, since the UI makes it impossible to submit without having
-- just accepted both. Run against the already-deployed production database
-- the same way migrations/0001-0008 were run:
--   wrangler d1 execute zettly-db --remote --file=./migrations/0009_add_acceptance_timestamps.sql

ALTER TABLE bookings ADD COLUMN liability_accepted_at TEXT;
ALTER TABLE bookings ADD COLUMN privacy_accepted_at TEXT;
