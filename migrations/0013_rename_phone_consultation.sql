-- The "phone consultation" checkbox was effectively dead code (it was gated
-- on a catalog field, leaf.phoneOptional, that was never actually set on
-- any leaf -- so this column has been 0 on every existing row). It's being
-- replaced with a proper "online consultation" option, gated on the
-- catalog's existing quoteKind: "consultation" leaves instead, so this
-- column is renamed to match rather than left stale.
--
-- Safe to run with existing data: every row currently has phone_consultation
-- = 0, so nothing meaningful is lost in the rename.
--
-- Run against the already-deployed production database the same way
-- migrations/0001-0012 were run:
--   wrangler d1 execute zettly-db --remote --file=./migrations/0013_rename_phone_consultation.sql

ALTER TABLE bookings RENAME COLUMN phone_consultation TO online_consultation;
