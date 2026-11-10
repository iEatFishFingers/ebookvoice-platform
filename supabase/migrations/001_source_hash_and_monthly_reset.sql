-- Migration 001: source-hash dedup + monthly conversion reset
-- Run via: Supabase SQL Editor
-- Safe to re-run (uses IF NOT EXISTS / IF EXISTS guards).
--
-- Run order:
--   1. THIS FILE  (additive: new column + cron job)
--   2. Deploy the new backend to Render and verify it's healthy
--   3. Run migrations/002_backfill_free_tier_limit.sql (data update)


-- ─── 1. audiobooks.source_hash ───────────────────────────────────────────────
-- SHA-256 of the first 64KB of the source EPUB.  Used to dedupe re-conversions
-- of the same book (different voices = same source = doesn't count again toward
-- the monthly conversion gate).  Nullable so old rows and old-app uploads still
-- work; a NULL means "we don't have a hash for this row" — those rows simply
-- don't participate in dedup.
ALTER TABLE audiobooks
  ADD COLUMN IF NOT EXISTS source_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_audiobooks_user_source_hash
  ON audiobooks (user_id, source_hash, created_at)
  WHERE source_hash IS NOT NULL;


-- ─── 2. Calendar-month conversion-counter reset ──────────────────────────────
-- Resets monthly_conversion_count to 0 on the 1st of every month at 00:00 UTC.
-- The backend gate logic also has a defensive inline reset that fires on each
-- conversion attempt — this cron is the primary, the inline check is the
-- fallback (covers users who happen to hit the API right at the boundary).
--
-- Requires the pg_cron extension.  Verify it's enabled:
--   Supabase Dashboard → Database → Extensions → pg_cron (toggle on if needed)
--
-- If pg_cron isn't available on the project, the inline reset in
-- entitlements.py will still keep behaviour correct — it will just run on
-- demand instead of on a schedule.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Drop any prior schedule with the same name so re-running this file is safe.
DO $$
BEGIN
  PERFORM cron.unschedule('reset-monthly-conversions');
EXCEPTION WHEN OTHERS THEN
  -- Job didn't exist; that's fine.
  NULL;
END;
$$;

SELECT cron.schedule(
  'reset-monthly-conversions',
  '0 0 1 * *',  -- 00:00 UTC on the 1st of each month
  $$
    UPDATE profiles
    SET monthly_conversion_count = 0,
        conversion_count_reset_at = date_trunc('month', now())
    WHERE monthly_conversion_count > 0;
  $$
);
