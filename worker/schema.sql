-- Zero Light shared cache (D1) — item #15, Layer 2.
-- Apply once at setup:
--   wrangler d1 execute zero-light-cache --file=worker/schema.sql
-- Rows are keyed lookups only (the free tier meters rows scanned).
-- There is no native TTL in D1: expires_at is enforced by the Worker on
-- read, and the hourly cron trigger sweeps long-expired rows.

CREATE TABLE IF NOT EXISTS cache_entries (
  key        TEXT PRIMARY KEY,
  body       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
