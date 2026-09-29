-- A tiny generic key/value settings table. First (and so far only) use: a
-- single global on/off switch so the owner can pause new bookings entirely
-- (no date range, just "closed until I turn it back on"), independent of
-- the per-day/half-day calendar_blocks from migration 0007.
-- Run against the already-deployed production database the same way
-- migrations/0001-0007 were run:
--   wrangler d1 execute zettly-db --remote --file=./migrations/0008_add_settings.sql

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
