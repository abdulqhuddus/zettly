-- Adds the table backing the admin login lockout (see src/auth.js). Run this
-- against the already-deployed production database the same way
-- migrations/0001 was run:
--   wrangler d1 execute zettly-db --remote --file=./migrations/0002_add_admin_login_attempts.sql

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  ip TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
