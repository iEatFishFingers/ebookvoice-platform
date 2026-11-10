# Karaoke was silently dropped on long books (Postgres statement timeout `57014`)

**Severity:** critical for the core audience · **Status:** resolved by removing the cause

## What happened

When a chapter INSERT hit a Supabase **statement timeout (`57014`)** — because its word-timings payload was too large — the handler stripped the timings and saved the chapter anyway:

```python
if '57014' in err_str or 'statement timeout' in err_str or 'canceling statement' in err_str:
    print(f"[WARN] chapter {row.get('position')} timed out — saving without word_timings …")
    row = {k: v for k, v in row.items() if k != 'word_timings'}
    ...
    return 'no_timings'
```

Saving the audio was the right call — a book that plays beats one that doesn't. The defect was that follow-along **silently disappeared** for those chapters with no retry, no user-facing notice, and no record beyond one log line:

```
⚠ Save partial: 23 full, 3 without karaoke timings, 0 failed / 26 total
```

It started as an apparent one-off (three ~3,500-word chapters of a 26-chapter classic) and grew to **11 chapter timeouts across 3 of 5 conversions** in a week — essentially every long book. For blind and print-disabled readers, the feature's main audience, losing follow-along on 10%+ of a book is a product defect.

A misleading detail: the WARN line printed the 0-based `position` directly above a 1-based loop counter, so the log named the wrong chapter.

## Resolution

Rather than retry the oversized statement, the cause was removed: word timings are uploaded to Cloudinary and Postgres stores only a URL ([word-timings storage](../subsystems/word-timings-storage.md)). With no multi-hundred-KB payload in the INSERT, the timeout can't occur and the strip-the-timings fallback is dead for new conversions. The 770 existing chapters were migrated with `scripts/backfill_word_timings.py`.

The same blobs were also behind the [egress outage](detail-fetch-egress.md) — one storage decision, failing on both the write side and the read side.

## Lessons

- **A graceful fallback that nobody hears about is a silent failure.** Degrade, but record and surface the degradation.
- **Large, immutable, non-relational blobs don't belong in row storage** on a statement-timeout-bound managed database.
