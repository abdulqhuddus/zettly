-- Lets the admin block off calendar time so nobody can book it: a whole day,
-- or just the morning/afternoon half. A blocked date range is exploded into
-- one row per date (each carrying its own period) rather than stored as a
-- range, so availability/booking checks stay a simple lookup by date.
-- Run against the already-deployed production database the same way
-- migrations/0001-0006 were run:
--   wrangler d1 execute zettly-db --remote --file=./migrations/0007_add_calendar_blocks.sql

CREATE TABLE IF NOT EXISTS calendar_blocks (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL, -- YYYY-MM-DD
  period TEXT NOT NULL CHECK (period IN ('full', 'am', 'pm')),
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calendar_blocks_date ON calendar_blocks(date);
