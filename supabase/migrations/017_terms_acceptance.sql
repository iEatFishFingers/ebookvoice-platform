-- Migration 011: profiles.terms_accepted_version + terms_accepted_at
-- Run via: Supabase SQL Editor
-- Safe to re-run (IF NOT EXISTS guards).
--
-- Records which version of the Terms of Service / Privacy Policy each user has
-- affirmatively accepted, and when. Used by the in-app re-consent gate: on
-- launch the frontend compares the user's terms_accepted_version against the
-- backend's current TERMS_VERSION and shows a one-time "We've updated our Terms"
-- prompt when they differ (or when it's NULL for users who predate the gate).
--
-- Both columns are nullable and additive — existing backend code keeps working
-- before this runs. Existing users will have NULL here, which the gate treats
-- as "must re-consent". New signups are stamped with the current version at
-- account creation (see auth.py), so they are not prompted twice.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS terms_accepted_version TEXT;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

-- Verification:
--   SELECT id, terms_accepted_version, terms_accepted_at FROM profiles LIMIT 5;
