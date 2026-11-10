-- Migration 014: shared demo audiobook — audiobooks.is_demo flag
--
-- WHY: every weekly data review lands on the same activation cliff — new
-- users (especially anonymous trials) arrive with no EPUB, see an empty
-- library, and leave. A pre-converted sample book that EVERY identity
-- (authenticated or anonymous device) sees in their library gives them an
-- instant first listen before we ask them to do any work.
--
-- HOW IT WORKS:
--  * The demo book is a completely normal audiobook row owned by the owner's
--    account (so the user_id XOR device_id CHECK from migration 010 holds),
--    with is_demo = TRUE.
--  * Backend /api/audiobooks appends is_demo rows to every library response;
--    /api/audiobooks/<id> allows any identity to fetch it.
--  * DELETE refuses demo rows (403). Progress writes from non-owners are
--    no-op'd server-side (shared row — one listener's position must not
--    clobber everyone else's).
--  * The anonymous conversion gate is untouched: it checks row-existence on
--    device_id, and demo rows carry user_id, not device_id.
--
-- SETUP (after running this migration + deploying the backend):
--  1. In the app, from the owner account, convert the chosen sample book
--     (recommended: a short recognisable classic from the Discover tab,
--     e.g. "Alice's Adventures in Wonderland", with a multilingual voice).
--  2. Find its id:   SELECT id, title FROM audiobooks
--                    WHERE user_id = '<owner-uuid>' ORDER BY created_at DESC LIMIT 5;
--  3. Flag it:       UPDATE audiobooks SET is_demo = TRUE WHERE id = '<uuid>';
--  4. Verify:        SELECT id, title, is_demo FROM audiobooks WHERE is_demo;
--
-- Additive-only: old backend code ignores the new column entirely.

ALTER TABLE audiobooks
  ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index: the library-list endpoint fetches demo rows on every
-- request from every user, so the lookup must never scan.
CREATE INDEX IF NOT EXISTS idx_audiobooks_is_demo
  ON audiobooks (is_demo)
  WHERE is_demo;
