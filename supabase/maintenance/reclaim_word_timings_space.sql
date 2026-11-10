-- Reclaim the space freed by the word-timings CDN offload
-- =======================================================
-- Run ONCE, in the Supabase SQL Editor, after
-- `scripts/backfill_word_timings.py --clear --confirm` reports 0 pending.
--
-- Context: the timings moved to Cloudinary on 2026-09-11 (migration 016).
-- 770 chapters x ~135 KB average = 104.2 MB of JSONB was nulled out. Postgres
-- does NOT hand those freed pages back to the operating system on its own, and
-- Supabase bills on what the OS sees — so without this step the dashboard
-- number does not move, however many rows were cleared.
--
-- See docs/reference/word-timings-storage.md
--
-- NOT a migration: it changes no schema and must not go in supabase/migrations/.
--
-- ===========================================================================
-- !! THE SUPABASE SQL EDITOR CANNOT RUN THIS FILE !!
-- ===========================================================================
-- The editor wraps every statement in a transaction, and Postgres refuses:
--
--     ERROR: 25001: VACUUM cannot run inside a transaction block
--
-- VACUUM needs an autocommit connection. Steps 1-3, 5 and 6 are plain SELECTs
-- and DO run fine in the editor — it is only step 4 that must go elsewhere.
--
-- To run step 4, use psql against the DIRECT connection (port 5432):
--
--   Supabase Dashboard -> Project Settings -> Database -> Connection string
--   (choose "Direct connection", NOT the transaction pooler on 6543 —
--    the pooler cannot run VACUUM either.)
--
--   psql "postgresql://postgres:[PASSWORD]@db.YOUR_PROJECT_REF.supabase.co:5432/postgres" \
--        -c "VACUUM (FULL, ANALYZE) audiobook_chapters;"
--
-- psql -c runs in autocommit, so this works. Install it with:
--   Fedora:  sudo dnf install postgresql
--   macOS:   brew install libpq
--
-- ===========================================================================
-- IS THIS EVEN URGENT?
-- ===========================================================================
-- Probably not. The UPDATEs that nulled the blobs left dead tuples; autovacuum
-- marks that space reusable, so the table will NOT keep growing — new chapters
-- reuse those pages. VACUUM FULL only returns the space to the OS so the
-- reported database size drops.
--
-- That matters if the free-tier limit that broke was DATABASE SIZE. It almost
-- certainly wasn't: the whole database is ~125 MB against a 500 MB cap. Egress
-- (5 GB/month) is the likely breach, and the fix for that — not shipping every
-- chapter's timings on every book open — is already deployed.
--
-- Confirm on the Supabase usage page before spending effort here.

-- ---------------------------------------------------------------------------
-- 1. Safety check — VACUUM FULL takes an ACCESS EXCLUSIVE lock on the table.
--    Reads AND writes to audiobook_chapters block for the duration, so a
--    conversion running at the same time would stall on its chapter inserts.
--    This must return ZERO rows before you continue.
-- ---------------------------------------------------------------------------
SELECT id, title, queue_status
FROM conversion_tasks
WHERE queue_status IN ('queued', 'processing');

-- ---------------------------------------------------------------------------
-- 2. Confirm there is nothing left to lose. Should return 0.
--    If it doesn't, stop — the backfill hasn't finished and VACUUM would
--    simply have less to reclaim.
-- ---------------------------------------------------------------------------
SELECT count(*) AS blobs_still_inline
FROM audiobook_chapters
WHERE word_timings IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Size before.
-- ---------------------------------------------------------------------------
SELECT pg_size_pretty(pg_total_relation_size('audiobook_chapters')) AS size_before;

-- ---------------------------------------------------------------------------
-- 4. The reclaim. Expect seconds on a table this size.
--    *** THIS STATEMENT CANNOT RUN IN THE SQL EDITOR *** — see the header.
--    Run it via psql on the direct connection, then come back for step 5.
-- ---------------------------------------------------------------------------
VACUUM (FULL, ANALYZE) audiobook_chapters;

-- ---------------------------------------------------------------------------
-- 5. Size after. This is the number that should drop by ~104 MB.
-- ---------------------------------------------------------------------------
SELECT pg_size_pretty(pg_total_relation_size('audiobook_chapters')) AS size_after;

-- ---------------------------------------------------------------------------
-- 6. Optional — the next-largest thing in the database, for reference.
--    conversion_tasks.chapters held 19.1 MB across 4 retained rows on
--    2026-09-11. Not actioned; it grows with every failed conversion.
-- ---------------------------------------------------------------------------
SELECT pg_size_pretty(pg_total_relation_size('conversion_tasks')) AS conversion_tasks_size;
