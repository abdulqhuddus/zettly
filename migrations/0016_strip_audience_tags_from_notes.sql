-- Every booking's notes used to be stored with "[business] "/"[home] " and
-- "[Kostenvoranschlag vor Ort] " prefixes tacked on (a stand-in for audience
-- and quote-type before those were derivable from service_id/the catalog
-- leaf, as admin.js now does). Showing up as literal text in the admin's
-- Notes field, it looked like a bug rather than the customer's own note.
-- New bookings no longer get these prefixes (see src/index.js); this
-- cleans up notes already stored with one.
--
-- Run against the already-deployed production database the same way
-- migrations/0001-0015 were run:
--   wrangler d1 execute zettly-db --remote --file=./migrations/0016_strip_audience_tags_from_notes.sql

UPDATE bookings
SET notes = TRIM(
  REPLACE(
    REPLACE(
      REPLACE(notes, '[business] ', ''),
      '[home] ', ''
    ),
    '[Kostenvoranschlag vor Ort] ', ''
  )
)
WHERE notes LIKE '%[business]%' OR notes LIKE '%[home]%' OR notes LIKE '%[Kostenvoranschlag vor Ort]%';

-- An existing booking whose notes were ONLY the tags (no actual customer
-- text) ends up with an empty string after the strip above; normalize that
-- back to NULL so the admin UI's "if (b.notes)" check hides the row exactly
-- like it never had notes.
UPDATE bookings SET notes = NULL WHERE notes = '';
