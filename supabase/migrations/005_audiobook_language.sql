-- Migration 005: audiobook language column
-- Run via: Supabase SQL Editor
-- Safe to re-run (uses IF NOT EXISTS guards).
--
-- Adds an ISO 639-1 language code (e.g. 'en', 'es', 'fr') to each audiobook.
-- The frontend uses this to filter the Library by language and badge each card.
-- Nullable so old rows (pre-migration) and old-app uploads keep working — the
-- backend insert path uses a defensive retry to drop this column on PGRST204
-- (schema cache miss) if the migration hasn't been applied yet.

ALTER TABLE audiobooks
  ADD COLUMN IF NOT EXISTS language TEXT;

-- Partial index: only books that have language set. Used by future Library
-- filters; keeps NULL rows out of the index footprint.
CREATE INDEX IF NOT EXISTS idx_audiobooks_user_language
  ON audiobooks (user_id, language)
  WHERE language IS NOT NULL;
