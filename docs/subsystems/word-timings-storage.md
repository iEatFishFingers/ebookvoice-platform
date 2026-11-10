# Where karaoke timings live

> **Timings are on Cloudinary, not in Postgres.** `audiobook_chapters.word_timings_url` holds the URL; the `word_timings` column is legacy and empty for anything converted after the offload (migration `016`).

## Why they moved

A word timing is one entry per word. Measured across every chapter in production at the time (770):

| | |
|---|--:|
| Median chapter | 112 KB |
| p95 | 327 KB |
| Max | 800 KB |
| **Total in Postgres** | **104.2 MB** |

That was about a fifth of the 500 MB database allowance, and `GET /api/audiobooks/<id>` used `select('*, audiobook_chapters(*)')` — the wildcard pulled **every** chapter's blob on **every** book open. It was simultaneously the biggest thing stored and the biggest thing on the wire.

It also caused the [statement-timeout karaoke loss](../incidents/karaoke-timings-statement-timeout.md): an oversized blob tripped Supabase's per-statement timeout on the chapter INSERT, and the handler dropped the timings to save the chapter.

Audio was never the problem — MP3s always went to Cloudinary. Timings were the one large thing left in the database, and they are neither relational nor mutable.

> **Don't trust a small sample when measuring skewed data.** The first version of `--status` sampled 10 unordered rows and reported **8.8 MB** — a 12× under-report, because the distribution is heavily skewed and the sample caught short chapters. It now measures every blob.

## How it works

```
conversion ──▶ upload_word_timings() ──▶ Cloudinary (resource_type='raw')
                                              │
                                              ▼
                             audiobook_chapters.word_timings_url
                                              │
           ┌──────────────────────────────────┴───────────────────────┐
           ▼                                                          ▼
  older app binaries                                        newer clients
  no query param                                            ?timings=url
  server hydrates inline                                    client fetches per chapter
  response shape unchanged                                  API server not in the path
```

**Two client generations are served by one endpoint, deliberately.** Binaries already on the App Store expect `word_timings` inline; they get it, hydrated from the CDN by `hydrate_word_timings()`. A client that passes `?timings=url` gets `wordTimingsUrl` instead and fetches only the chapter it needs. Hydration is the **default** so a binary that never sends the parameter keeps working. Both shapes are locked down by `tests/test_audiobook_detail_timings.py`.

### Client cache (`mobile-app/src/services/wordTimings.ts`)

Resolution order: **inline blob (legacy row) → memory → disk → CDN**.

- Timings are immutable (the audio they describe never changes), so the disk cache never needs invalidating.
- Memory is capped at **5 chapters** — a parsed 5,000-word chapter is thousands of objects.
- A payload that isn't a timings array is treated as a **miss**, not cached. A CDN 404 page or a captive-portal login screen parses as JSON perfectly happily.

## Pitfalls

**HTTP 200 does not mean a deleted asset survived.** Cloudinary's CDN keeps serving a deleted raw file from edge cache for a while, even with `invalidate=True`. The authority is the Admin API: `cloudinary.api.resource(public_id, resource_type='raw')` raising `NotFound`. Run a control lookup on a known-live asset in the same pass so a broken lookup can't masquerade as a deletion.

**Raw public_ids keep their file extension.** In `word_timings/<book>_<pos>.json` the `.json` is part of the public_id. `extract_public_id()` strips extensions (correct for the `.mp3`/`.jpg` assets it was written for), so `destroy()` with it silently no-ops and leaks the file. `_safe_destroy_raw()` handles raw assets; audiobook deletion and account deletion both use it. See [the latent defect](../incidents/raw-public-id-keeps-its-extension.md).

**Never null the blobs while a pre-offload backend is live.** A backend that predates the offload selects `audiobook_chapters(*)` and has never heard of `word_timings_url`; clearing inline blobs under it returns `word_timings: null` for every book. `backfill_word_timings.py --clear` refuses to run without `--confirm`.

**Hydration must never use `with ThreadPoolExecutor(...)`.** `__exit__` calls `shutdown(wait=True)`, which waits for every queued fetch regardless of the time budget — on a 40-chapter book with a slow CDN, ~50 s of a single sync gunicorn worker blocked solid. The code uses an explicit `shutdown(wait=False, cancel_futures=True)`, and a regression test fails if the `with` block comes back.

## Production verification

The write path was verified with a full conversion against production after deploy:

| Check | Result |
|---|---|
| Conversion completes | ~10 s for a 161-word chapter |
| `word_timings` in Postgres | NULL |
| `word_timings_url` | set |
| CDN file | 157 timings, valid shape, sorted |
| Legacy client | 157 timings hydrated from the CDN |
| New client (`?timings=url`) | URL returned, no hydration |
| `_safe_destroy_raw()` | asset removed (confirmed via Admin API, not HTTP) |

## Operating it — `scripts/backfill_word_timings.py`

```bash
python scripts/backfill_word_timings.py --status          # counts + true reclaimable size
python scripts/backfill_word_timings.py --upload          # pass 1: additive, safe any time
python scripts/backfill_word_timings.py --clear --confirm # pass 2: needs the new backend live
python scripts/backfill_word_timings.py --vacuum-sql
```

Two passes on purpose. `--upload` leaves **both** columns populated, so mistakes are recoverable. `--clear` nulls the blob only for chapters whose CDN copy fetches back and matches field by field (`timings_match()`, ±2 ms). Neither pass is offset-paginated — each drains a work queue defined by its own filter, so an interrupted run resumes without skipping or repeating rows.

The space-reclaim step lives in `supabase/maintenance/reclaim_word_timings_space.sql`, deliberately outside `supabase/migrations/` because it changes no schema.

> `VACUUM FULL` cannot run in the Supabase SQL Editor — the editor wraps statements in a transaction (`25001: VACUUM cannot run inside a transaction block`). It needs an autocommit `psql` connection on the **direct** port 5432 (the transaction pooler on 6543 can't do it either). It takes an ACCESS EXCLUSIVE lock, so run it at low traffic and never during a conversion. Dead tuples left by nulling are reused by autovacuum anyway; `VACUUM FULL` only shrinks the *reported* size.

## Related

- [Karaoke timings](karaoke-timings.md) — the pipeline that produces this data
- [Server architecture](../operations/server-architecture.md) — the single sync worker that shaped the hydration design
