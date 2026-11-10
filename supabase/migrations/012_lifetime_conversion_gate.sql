-- Migration 012: lifetime conversion gate (June 2026 v2)
-- Run via: Supabase SQL Editor.  Safe to re-run.
--
-- The paid gate is now LIFETIME successful conversions, counted in the
-- repurposed `profiles.conversion_count` column (previously dead — always 0).
-- Caps live in tier_limits.py: free 2 / starter 10 / pro+enterprise unlimited.
-- The counter increments ONLY when a conversion completes and never decreases
-- (deleting an audiobook does NOT free a slot). This replaces the short-lived
-- library-size gate. See CLAUDE.md → "Paywall: LIFETIME conversion count".
--
-- `conversion_count` already exists with default 0, so no column change is
-- needed and every existing user starts with a fresh allowance.

-- Atomic increment so two concurrent completions for the same user can't race
-- and under-count (mirrors migration 003's pattern). The backend calls this on
-- conversion completion; it falls back to read-modify-write if absent.
CREATE OR REPLACE FUNCTION increment_conversion_count(p_user_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE profiles
  SET conversion_count = COALESCE(conversion_count, 0) + 1
  WHERE id = p_user_id;
$$;

GRANT EXECUTE ON FUNCTION increment_conversion_count(uuid) TO authenticated, service_role;

-- OPTIONAL (stricter rollout) — count each user's EXISTING audiobooks against
-- their lifetime cap, so current libraries aren't a free pass. Leave commented
-- to start everyone fresh (recommended for the experiment; only ~tens of users):
--   UPDATE profiles p
--   SET conversion_count = (
--     SELECT count(*) FROM audiobooks a WHERE a.user_id = p.id
--   );

-- Verify:
--   SELECT id, subscription_tier, conversion_count
--   FROM profiles ORDER BY conversion_count DESC LIMIT 20;
