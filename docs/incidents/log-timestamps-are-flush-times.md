# Log timestamps were flush times, not event times — stdout was block-buffered

**Severity:** low (but it corrupted every incident timeline) · **Status:** resolved

## What was wrong

Incident timelines reconstructed from the Render logs were off by up to ~90 minutes:

- eleven chapters of one conversion all carried the same timestamp
- a `CONVERSION COMPLETE` line was stamped ~1.5 hours after the database row's own `created_at`
- a worker's startup lines appeared an hour after it booted — which on first read looked like an hour-long outage

Only gunicorn's access log and the platform's own lines were stamped when they happened.

## Cause

Python `print()` to a non-tty stdout is **block-buffered**. Nothing set `PYTHONUNBUFFERED`, so application lines sat in a buffer until it filled or the worker exited — and a worker killed by a restart **lost** whatever was buffered, which is why some crashed conversions had no log lines after their first chapter.

## Fix

`ENV PYTHONUNBUFFERED=1` in the `Dockerfile`. No code or behaviour change beyond honest timestamps. HTTP errors were also changed to keep their original status codes in logs.

## Lesson

**Before trusting a log timeline, check that the timestamps are event times.** Cross-reference against a source that is stamped at write time (database rows, access logs).
