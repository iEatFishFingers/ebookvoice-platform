-- Migration 015: BookShare OAuth token storage
--
-- One row per EbookVoice user who has connected their BookShare account
-- (bookshare.org — the accessible library for print-disabled readers).
-- Written/read ONLY by the backend with the service-role key; RLS is enabled
-- with no policies so anon/authenticated clients can never touch tokens.
--
-- The integration ships dormant: no rows exist (and no BookShare UI shows)
-- until BOOKSHARE_API_KEY + BOOKSHARE_CLIENT_SECRET are set on Render.
-- Additive-only: nothing else references this table.

CREATE TABLE IF NOT EXISTS bookshare_tokens (
  user_id       UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Service-role-only access: enable RLS and define no policies.
ALTER TABLE bookshare_tokens ENABLE ROW LEVEL SECURITY;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'bookshare_tokens';
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'bookshare_tokens';  -- t
