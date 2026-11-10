-- Migration 010: anonymous trial — device_id columns + nullable user_id
-- Run via: Supabase SQL Editor
-- Safe to re-run (uses IF NOT EXISTS / DO blocks with EXCEPTION guards).
--
-- Lets unauthenticated users convert 1 book each, tied to a client-side device
-- UUID (stored in expo-secure-store). When they sign up, /api/anonymous/claim
-- atomically moves the audiobook + chapter + task rows from device_id to
-- user_id. The schema must permit either identity on its own.
--
-- IMPORTANT — Supabase RPC update required before code deploy:
--   The `claim_next_queued_task` RPC (defined directly in the Supabase
--   dashboard, NOT in this migrations directory) must either do `SELECT *` or
--   explicitly include `device_id` in its returned column list. Verify by
--   running in the SQL Editor:
--     SELECT pg_get_functiondef(oid) FROM pg_proc
--     WHERE proname = 'claim_next_queued_task';
--   If `device_id` is missing, edit the function definition to add it. Without
--   this, anonymous conversions will silently fail to save (worker receives
--   the task without device_id, the `if user_id:` save guard skips the insert).


-- ─── 1. audiobooks.device_id ─────────────────────────────────────────────────
-- Client-generated UUID identifying the device that owns this anonymous
-- audiobook. NULL for rows owned by a real user (user_id set instead).
ALTER TABLE audiobooks
  ADD COLUMN IF NOT EXISTS device_id TEXT;

-- Partial index for the "does this device already have a book?" gate query.
-- WHERE clause keeps the index small — only anonymous rows.
CREATE INDEX IF NOT EXISTS idx_audiobooks_device_id
  ON audiobooks (device_id)
  WHERE device_id IS NOT NULL;


-- ─── 2. conversion_tasks.device_id ───────────────────────────────────────────
ALTER TABLE conversion_tasks
  ADD COLUMN IF NOT EXISTS device_id TEXT;

CREATE INDEX IF NOT EXISTS idx_conversion_tasks_device_id
  ON conversion_tasks (device_id)
  WHERE device_id IS NOT NULL;


-- ─── 3. Drop NOT NULL on user_id (both tables) ───────────────────────────────
-- Wrapped in DO blocks so the migration is a no-op if user_id is already
-- nullable from a prior run.
DO $$
BEGIN
  ALTER TABLE audiobooks ALTER COLUMN user_id DROP NOT NULL;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

DO $$
BEGIN
  ALTER TABLE conversion_tasks ALTER COLUMN user_id DROP NOT NULL;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;


-- ─── 4. CHECK constraints: exactly one identity per row ──────────────────────
-- (user_id, device_id) must be exactly one non-null on each row. Postgres
-- evaluates the CHECK after the full statement is applied, so a single
-- UPDATE statement that sets user_id=$uid, device_id=NULL during claim is
-- valid even though the row transitions through "both set" conceptually.
--
-- DROP-first so re-running this migration with a tightened constraint works.

DO $$
BEGIN
  ALTER TABLE audiobooks DROP CONSTRAINT IF EXISTS chk_audiobooks_identity;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

ALTER TABLE audiobooks
  ADD CONSTRAINT chk_audiobooks_identity CHECK (
    (user_id IS NOT NULL AND device_id IS NULL)
    OR (user_id IS NULL AND device_id IS NOT NULL)
  );

DO $$
BEGIN
  ALTER TABLE conversion_tasks DROP CONSTRAINT IF EXISTS chk_conversion_tasks_identity;
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

ALTER TABLE conversion_tasks
  ADD CONSTRAINT chk_conversion_tasks_identity CHECK (
    (user_id IS NOT NULL AND device_id IS NULL)
    OR (user_id IS NULL AND device_id IS NOT NULL)
  );


-- ─── Verification queries (run after migration) ──────────────────────────────
-- 1. Columns exist:
--    SELECT column_name, is_nullable, data_type
--    FROM information_schema.columns
--    WHERE table_name IN ('audiobooks', 'conversion_tasks')
--      AND column_name IN ('user_id', 'device_id')
--    ORDER BY table_name, column_name;
--
-- 2. CHECK constraints present:
--    SELECT conname, pg_get_constraintdef(oid)
--    FROM pg_constraint
--    WHERE conname IN ('chk_audiobooks_identity', 'chk_conversion_tasks_identity');
--
-- 3. Indexes present:
--    SELECT indexname FROM pg_indexes
--    WHERE indexname IN ('idx_audiobooks_device_id', 'idx_conversion_tasks_device_id');
--
-- 4. Existing data still valid:
--    SELECT count(*) FROM audiobooks WHERE user_id IS NULL AND device_id IS NULL;  -- expect 0
--    SELECT count(*) FROM conversion_tasks WHERE user_id IS NULL AND device_id IS NULL;  -- expect 0
