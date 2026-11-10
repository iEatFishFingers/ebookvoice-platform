-- Migration 008: adds retry_count to conversion_tasks.
--
-- Enables the retry-cap logic in requeue_stuck_tasks (migration 009): instead
-- of resurrecting a poison task forever (which is what OOM-crash-looped the
-- worker on 2026-05-26), the requeue function now marks the task 'failed'
-- after MAX_RETRIES attempts so one bad task can't take the service down.
--
-- Additive + IF NOT EXISTS: safe to re-run; old backend code that doesn't
-- read retry_count keeps working (defaults to 0).
--
-- Run by hand in Supabase SQL Editor.

ALTER TABLE conversion_tasks
ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

-- Verification:
--   SELECT column_name, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'conversion_tasks' AND column_name = 'retry_count';
