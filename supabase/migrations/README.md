# Database migrations

These SQL files are **run by hand** in the Supabase SQL Editor
(Dashboard → SQL Editor → paste → Run). There is no automatic migration
runner — Supabase doesn't ship one for self-managed projects on the free
plan, and the project has historically applied schema changes manually.

## Order

Run files in numeric order. Skipping or running out of order is unsafe
unless a file's header explicitly says "safe to re-run".

| File | What it does | Run after |
|---|---|---|
| `001_source_hash_and_monthly_reset.sql` | Adds `audiobooks.source_hash` for retry-doesn't-count dedup; schedules a `pg_cron` job that resets `monthly_conversion_count` on the 1st of every month at 00:00 UTC. | — |
| `002_backfill_free_tier_limit.sql` | Bumps existing free-tier users from `max_monthly_conversions = 2` to `5`. | After 001 + new backend deploy is verified healthy. |
| `003_atomic_conversion_counter.sql` | Adds `increment_monthly_conversion_count(uuid)` RPC so the conversion counter is incremented as a single atomic Postgres `UPDATE`, eliminating the read-modify-write race when two conversions complete simultaneously. | After 001. |
| `004_conversion_tasks_is_retry.sql` | Adds `conversion_tasks.is_retry` boolean. The enqueue path stashes this so the worker knows to skip the counter increment when a "retry" (same source EPUB this calendar month) completes. Without it `/convert-chapters` fails with PGRST204 and the task is never persisted. | After 001. |
| `005_audiobook_language.sql` | Adds `audiobooks.language` (ISO 639-1 code) + partial index. Used by the multilanguage feature to filter the Library by language and stamp each converted audiobook with the language picked at upload time. | Independent of others. |
| `006_conversion_tasks_language.sql` | Adds `conversion_tasks.language`. Lets `/convert-chapters` carry the language code through the task queue so the worker can stamp it on the audiobook row at the end. Without it `task_manager.create_task` falls back to a retry-without-language path, so tasks still run but `audiobooks.language` is never populated. | After 005. |
| `007_conversion_tasks_image_upload_id.sql` | Adds `conversion_tasks.image_upload_id`. Carries the background image-upload token through the queue so the worker knows which cache entry to wait on before saving chapter rows. | After 006. |
| `008_conversion_tasks_retry_count.sql` | Adds `conversion_tasks.retry_count`. Counts how many times the stuck-task sweep has requeued a task; tasks exceeding the cap are flipped to `failed` rather than re-queued forever. | Independent. |
| `009_requeue_stuck_tasks_with_retry_cap.sql` | Replaces the `requeue_stuck_tasks` RPC with a version that honors the new `retry_count` cap. | After 008. |
| `010_anonymous_device_columns.sql` | Adds nullable `device_id TEXT` to `audiobooks` and `conversion_tasks`, drops `NOT NULL` on `user_id` for both tables, and adds CHECK constraints `chk_audiobooks_identity` / `chk_conversion_tasks_identity` ensuring exactly one of (user_id, device_id) per row. Enables the anonymous-trial flow where unauthenticated users get a 1-book lifetime conversion tied to a device UUID. **PRE-DEPLOY MANUAL STEP**: open the `claim_next_queued_task` RPC in the Supabase dashboard and confirm it either does `SELECT *` or explicitly returns `device_id` in its column list — otherwise the worker won't receive the device identity from claimed anonymous tasks and silently fails to save the audiobook. | After 004. |
| `014_demo_audiobook.sql` | Adds `audiobooks.is_demo BOOLEAN DEFAULT FALSE` + partial index. The demo/sample book is a normal audiobook row owned by the owner's account, flagged `is_demo`; the backend appends it to every library response (incl. anonymous devices), refuses DELETE on it, and no-ops progress writes from non-owners. **POST-MIGRATION MANUAL STEP**: convert the sample book from the owner account in the app, then `UPDATE audiobooks SET is_demo = TRUE WHERE id = '<uuid>';` (full steps in the migration file header). | After 010. |
| `015_bookshare_tokens.sql` | Creates `bookshare_tokens` (user_id PK → auth.users, access/refresh token, expiry) for the BookShare OAuth integration. RLS enabled with no policies — service-role only. Integration stays dormant until `BOOKSHARE_API_KEY` + `BOOKSHARE_CLIENT_SECRET` env vars are set on Render. | Independent. |

## Conventions

- All migrations are **additive and non-destructive**: nullable column adds,
  function definitions, scheduled-job inserts. Nothing drops a column or
  table. Every backend deploy must remain backward-compatible with the
  previous deploy for at least one cycle.
- Files that introduce a new column add it as **nullable** so the
  *previous* backend code (which doesn't know about the column) keeps
  inserting and selecting without error.
- `pg_cron` extension is required for 001's scheduled job. If your
  Supabase plan doesn't include `pg_cron`, the inline reset in
  `_check_conversion_gate` (epub_to_audio.py) handles month boundaries
  correctly on the next conversion attempt — you can skip the `cron.schedule`
  block. The schema parts (`ALTER TABLE`, `CREATE INDEX`) still need to run.

## How to run

1. Open https://supabase.com/dashboard → your project → SQL Editor.
2. Paste the file contents.
3. Click **Run**. Each file is wrapped to be idempotent (`IF NOT EXISTS`,
   `CREATE OR REPLACE`); re-running on an already-applied file is harmless.

## Verifying

After running, smoke-check:

```sql
-- 001 applied?
SELECT column_name FROM information_schema.columns
WHERE table_name = 'audiobooks' AND column_name = 'source_hash';

-- 002 applied?
SELECT subscription_tier, max_monthly_conversions, COUNT(*)
FROM profiles GROUP BY 1, 2 ORDER BY 1;
-- All free rows should show max_monthly_conversions = 5

-- 003 applied?
SELECT proname FROM pg_proc WHERE proname = 'increment_monthly_conversion_count';

-- 004 applied?
SELECT column_name FROM information_schema.columns
WHERE table_name = 'conversion_tasks' AND column_name = 'is_retry';

-- 005 applied?
SELECT column_name FROM information_schema.columns
WHERE table_name = 'audiobooks' AND column_name = 'language';

-- 006 applied?
SELECT column_name FROM information_schema.columns
WHERE table_name = 'conversion_tasks' AND column_name = 'language';

-- 010 applied?
SELECT column_name, is_nullable FROM information_schema.columns
WHERE table_name IN ('audiobooks', 'conversion_tasks')
  AND column_name IN ('user_id', 'device_id')
ORDER BY table_name, column_name;
-- Both user_id rows should be is_nullable=YES; both device_id rows should exist.

SELECT conname FROM pg_constraint
WHERE conname IN ('chk_audiobooks_identity', 'chk_conversion_tasks_identity');
-- Both constraint names should appear.
```
