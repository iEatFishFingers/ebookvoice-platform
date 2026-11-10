-- Migration 016: audiobook_chapters.word_timings_url
-- Run via: Supabase SQL Editor
-- Safe to re-run (IF NOT EXISTS guard).
--
-- Karaoke word timings are one entry per word — ~400 KB of JSONB on a
-- 5,000-word chapter. Held in Postgres they are simultaneously the largest
-- consumer of database size, the largest payload on the wire when a book is
-- opened, and the cause of the per-statement timeouts (57014) that make
-- /api/audiobooks/<id> drop karaoke on long books.
--
-- They are immutable once generated and only the Player reads them, so they
-- belong on the CDN next to the chapter's MP3, not in a relational database.
-- This column holds the Cloudinary URL of that JSON file.
--
-- Additive and nullable by design:
--   * NULL + word_timings populated  → legacy row, timings still inline
--     (until the phase-3 backfill runs)
--   * populated + word_timings NULL  → new row, timings on the CDN
-- Both shapes are served identically by GET /api/audiobooks/<id>, so live
-- binaries (builds 38 and 39) keep working unchanged.

ALTER TABLE audiobook_chapters
  ADD COLUMN IF NOT EXISTS word_timings_url TEXT;

-- Verify:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'audiobook_chapters' AND column_name = 'word_timings_url';
