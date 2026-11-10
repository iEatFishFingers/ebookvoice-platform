-- Migration 011: push tokens for anonymous (device-only) users
-- Run via: Supabase SQL Editor. Additive; safe to re-run.
--
-- Why: /api/push-token required an account, so the "Audiobook Ready! 🎧"
-- push only ever reached signed-in users. Anonymous trials — the funnel —
-- got nothing: 6 of the 11 books delivered 2026-09-10 → 09-14 went
-- unannounced, and one tester found hers two days later.
-- See docs/reference/findings/anonymous-no-ready-push.md.
--
-- Row per device, keyed by the same client UUID that owns anonymous
-- audiobooks/conversion_tasks (X-Device-Id, migration 010). Written and read
-- ONLY by the backend through the service role: RLS is enabled with no
-- policies, so the anon/authenticated PostgREST roles can neither read nor
-- write it. Rows are deleted when the device's books are claimed by an
-- account (/api/anonymous/claim) — the token then lives on profiles.

create table if not exists device_push_tokens (
  device_id       text primary key,
  expo_push_token text not null,
  updated_at      timestamptz not null default now()
);

alter table device_push_tokens enable row level security;
alter table device_push_tokens force row level security;

comment on table device_push_tokens is
  'Expo push tokens for anonymous-trial devices (X-Device-Id). Service-role only — no RLS policies by design.';
