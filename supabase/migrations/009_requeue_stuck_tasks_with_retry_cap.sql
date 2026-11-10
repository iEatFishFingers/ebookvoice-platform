-- Migration 009: replaces requeue_stuck_tasks RPC with retry-cap logic.
--
-- Why: on 2026-05-26 a 2.74M-word EPUB OOM-crash-looped the 512MB Render
-- worker. The OOM kills the container before the worker can mark the task
-- 'failed', so on restart the existing requeue function flipped the task
-- back to 'queued' → claimed again → OOM again → infinite loop every ~5 min
-- for hours, destabilising the whole backend.
--
-- Fix: track retry_count (migration 008) and after MAX retries, mark the
-- task 'failed' instead of requeuing it. The size cap (MAX_CONVERSION_WORDS)
-- blocks the *usual* trigger, but this is defence-in-depth — any task that
-- dies mid-run (network blip, weird EPUB, other transient) now fails
-- gracefully instead of taking the service down.
--
-- Signature: adds p_max_retries with DEFAULT 3 so any old caller that
-- passes only p_stuck_threshold_minutes continues to work unchanged.
-- Return: count of tasks REQUEUED (same as before — preserves existing
-- logging in queue_manager.py).
--
-- Run by hand in Supabase SQL Editor. CREATE OR REPLACE — idempotent.

CREATE OR REPLACE FUNCTION requeue_stuck_tasks(
    p_stuck_threshold_minutes INTEGER,
    p_max_retries INTEGER DEFAULT 3
) RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_requeued_count INTEGER;
    v_failed_count   INTEGER;
BEGIN
    -- 1. Poison-task fail-out: stuck > threshold AND at/above the retry cap.
    --    These keep crashing the worker; mark 'failed' so they stop being
    --    resurrected. complete=true so the polling UI sees a terminal state.
    --    Preserved (not deleted) for inspection — cleanup_old_tasks ignores
    --    'failed' rows.
    UPDATE conversion_tasks
    SET queue_status = 'failed',
        complete     = TRUE,
        error        = COALESCE(error, '') ||
                       ' [auto-failed by requeue_stuck_tasks: exceeded max_retries=' ||
                       p_max_retries || ']'
    WHERE queue_status = 'processing'
      AND started_at < (NOW() - (p_stuck_threshold_minutes || ' minutes')::INTERVAL)
      AND retry_count >= p_max_retries;

    GET DIAGNOSTICS v_failed_count = ROW_COUNT;
    IF v_failed_count > 0 THEN
        RAISE NOTICE 'requeue_stuck_tasks: auto-failed % poison-task(s)', v_failed_count;
    END IF;

    -- 2. Requeue: stuck > threshold but still under the cap. Bump retry_count
    --    and clear started_at so the next attempt is clean.
    UPDATE conversion_tasks
    SET queue_status = 'queued',
        retry_count  = retry_count + 1,
        started_at   = NULL
    WHERE queue_status = 'processing'
      AND started_at < (NOW() - (p_stuck_threshold_minutes || ' minutes')::INTERVAL)
      AND retry_count < p_max_retries;

    GET DIAGNOSTICS v_requeued_count = ROW_COUNT;
    RETURN v_requeued_count;
END;
$$;

-- Verification:
--   -- See current stuck-task counts by retry_count tier:
--   SELECT retry_count,
--          COUNT(*) FILTER (WHERE queue_status='queued')     AS queued,
--          COUNT(*) FILTER (WHERE queue_status='processing') AS processing,
--          COUNT(*) FILTER (WHERE queue_status='failed')     AS failed
--   FROM conversion_tasks
--   GROUP BY retry_count ORDER BY retry_count;
--
--   -- Dry-run the function (won't change anything if no tasks are stuck):
--   SELECT requeue_stuck_tasks(2, 3);
