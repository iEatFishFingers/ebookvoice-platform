-- Migration 003: atomic monthly_conversion_count increment
-- Run via: Supabase SQL Editor.  Safe to re-run.
--
-- Replaces the read-then-write pattern in process_chapters_conversion
-- (which races when two conversions complete concurrently and ends up
-- under-counting).  This RPC does the increment as a single UPDATE,
-- which Postgres applies atomically to the row.

CREATE OR REPLACE FUNCTION increment_monthly_conversion_count(p_user_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE profiles
  SET monthly_conversion_count = COALESCE(monthly_conversion_count, 0) + 1
  WHERE id = p_user_id;
$$;

-- Allow the service-role client (and authenticated users acting on
-- their own profile via RLS) to call it.
GRANT EXECUTE ON FUNCTION increment_monthly_conversion_count(uuid) TO authenticated, service_role;
