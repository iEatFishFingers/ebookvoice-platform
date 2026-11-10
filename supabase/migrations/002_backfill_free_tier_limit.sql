-- Migration 002: backfill free-tier conversion limit from 2 → 5
-- Run via: Supabase SQL Editor
-- Run AFTER 001 has been applied AND the new backend is deployed and healthy.
--
-- This is the data half of the paywall change.  Free users now get 5
-- conversions per calendar month instead of 2.
--
-- The new backend's /convert-chapters gate reads max_monthly_conversions
-- from each profile row directly, so this UPDATE is what actually changes the
-- limit users see.  Reverting is one symmetric UPDATE (set back to 2) — no
-- code rollback required.

UPDATE profiles
SET max_monthly_conversions = 5
WHERE subscription_tier = 'free'
  AND max_monthly_conversions = 2;

-- For anyone who hit their old 2-cap this calendar month: do NOT zero out
-- their monthly_conversion_count.  They still consumed 2 conversions; they
-- now have 3 more available this month.  That's the intended behaviour and
-- matches the philosophy ("free is more generous now") without retroactive
-- gifts that could be perceived as a glitch.
