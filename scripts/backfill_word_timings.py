"""
backfill_word_timings.py
========================
Move existing chapters' karaoke timings out of Postgres and onto Cloudinary.

Phase 3 of docs/plans/2026-09-11-word-timings-offload.md. Migration 016 added
`audiobook_chapters.word_timings_url`; phase 1 made new conversions write
there. This script does the same for every book that already exists, then
frees the space.

> [!danger] Deploy phase 1 BEFORE running --clear
> --clear nulls the inline blob. A backend that predates phase 1 selects
> `audiobook_chapters(*)` and has never heard of word_timings_url, so it would
> serve `word_timings: null` and every existing book would silently lose
> karaoke. --upload is safe to run any time; --clear is not.

Two passes on purpose, so a mistake in the first is recoverable:

    --upload   write the JSON to the CDN and record the URL.
               Purely additive: both columns end up populated.

    --clear    null the inline blob, but ONLY for chapters whose CDN copy
               fetches back and matches the database value.

Neither pass is offset-paginated. Both drain a work queue defined by their own
filter, so an interrupted run simply resumes — nothing is skipped and nothing
is processed twice.

Usage
-----
    python scripts/backfill_word_timings.py --status
    python scripts/backfill_word_timings.py --upload --dry-run
    python scripts/backfill_word_timings.py --upload
    python scripts/backfill_word_timings.py --clear --dry-run
    python scripts/backfill_word_timings.py --clear --confirm
    python scripts/backfill_word_timings.py --vacuum-sql

Bound any run with --limit N. Reads SUPABASE_URL, SUPABASE_SERVICE_KEY and the
CLOUDINARY_* vars from .env, same as the backend.
"""
import os
import io
import sys
import json
import time
import argparse
from dotenv import load_dotenv
from supabase import create_client

import cloudinary
import cloudinary.uploader
import requests as http_requests

load_dotenv()

# Credentials are resolved lazily rather than at import: --vacuum-sql needs
# none of them, and the pure comparison logic below has to stay importable by
# the test suite without a live project.
_sb = None


def sb():
    """Supabase client, created on first use."""
    global _sb
    if _sb is None:
        url = os.environ.get('SUPABASE_URL')
        key = os.environ.get('SUPABASE_SERVICE_KEY') or os.environ.get('SUPABASE_KEY')
        if not url or not key:
            sys.exit('[ERROR] SUPABASE_URL and SUPABASE_SERVICE_KEY required in .env')
        _sb = create_client(url, key)
    return _sb


def configure_cloudinary():
    if not os.environ.get('CLOUDINARY_CLOUD_NAME'):
        sys.exit('[ERROR] CLOUDINARY_* credentials required in .env')
    cloudinary.config(
        cloud_name=os.environ.get('CLOUDINARY_CLOUD_NAME'),
        api_key=os.environ.get('CLOUDINARY_API_KEY'),
        api_secret=os.environ.get('CLOUDINARY_API_SECRET'),
    )


WORD_TIMINGS_FOLDER = 'word_timings'
PAGE = 25                 # rows per round trip; blobs are large, keep it small
TOLERANCE_S = 0.002       # timings are rounded to 3dp upstream


# ── helpers ──────────────────────────────────────────────────────────────────

def human(n_bytes):
    for unit in ('B', 'KB', 'MB', 'GB'):
        if abs(n_bytes) < 1024:
            return f'{n_bytes:.1f} {unit}'
        n_bytes /= 1024
    return f'{n_bytes:.1f} TB'


def timings_match(a, b):
    """
    True if two timing arrays are the same data.

    Compared field-by-field with a tolerance rather than by equality: the value
    makes a round trip through JSONB and back through JSON, and a float that
    differs in the last bit is not a reason to refuse to free the row.
    """
    if a is None or b is None or len(a) != len(b):
        return False
    for x, y in zip(a, b):
        if x.get('word') != y.get('word'):
            return False
        for key in ('start', 'end'):
            try:
                if abs(float(x.get(key, 0)) - float(y.get(key, 0))) > TOLERANCE_S:
                    return False
            except (TypeError, ValueError):
                return False
    return True


def public_id_for(chapter):
    return f"{chapter['audiobook_id']}_{chapter['position']}"


# ── --status ─────────────────────────────────────────────────────────────────

def cmd_status():
    def base():
        return sb().table('audiobook_chapters').select('id', count='exact').limit(1)

    total = base().execute().count or 0
    inline = base().not_.is_('word_timings', 'null').execute().count or 0
    on_cdn = base().not_.is_('word_timings_url', 'null').execute().count or 0
    pending_upload = (base().not_.is_('word_timings', 'null')
                      .is_('word_timings_url', 'null').execute().count or 0)
    pending_clear = (base().not_.is_('word_timings', 'null')
                     .not_.is_('word_timings_url', 'null').execute().count or 0)

    print(f'chapters total          : {total}')
    print(f'  with inline timings   : {inline}')
    print(f'  with a CDN url        : {on_cdn}')
    print()
    print(f'pending --upload        : {pending_upload}')
    print(f'pending --clear         : {pending_clear}')

    if not inline:
        return

    # Measure every blob rather than sampling. Chapter sizes are wildly skewed
    # (measured 2026-09-11: median 112 KB, p95 327 KB, max 800 KB), so a small
    # sample is not merely imprecise — a 10-row one under-reported the total by
    # 12x, which is the difference between "not worth doing" and "a fifth of
    # the database".
    print()
    print('measuring every blob (no sampling — chapter sizes are heavily skewed)...')
    sizes = []
    offset = 0
    while True:
        page = (sb().table('audiobook_chapters').select('word_timings')
                .not_.is_('word_timings', 'null')
                .order('id').range(offset, offset + PAGE - 1).execute().data or [])
        if not page:
            break
        sizes.extend(len(json.dumps(r['word_timings'], separators=(',', ':'))) for r in page)
        offset += PAGE

    if not sizes:
        return
    sizes.sort()
    total = sum(sizes)
    print()
    print(f'  measured              : {len(sizes)} blobs')
    print(f'  median                : {human(sizes[len(sizes) // 2])}')
    print(f'  p95                   : {human(sizes[int(len(sizes) * 0.95)])}')
    print(f'  max                   : {human(sizes[-1])}')
    print(f'  TOTAL reclaimable     : {human(total)}  (after --clear + VACUUM FULL)')


# ── --upload ─────────────────────────────────────────────────────────────────

def cmd_upload(limit, dry_run):
    configure_cloudinary()
    done = failed = 0
    bytes_moved = 0
    while limit is None or done + failed < limit:
        batch = PAGE if limit is None else min(PAGE, limit - done - failed)
        rows = sb().table('audiobook_chapters')\
            .select('id, audiobook_id, position, word_timings')\
            .not_.is_('word_timings', 'null')\
            .is_('word_timings_url', 'null')\
            .order('id')\
            .limit(batch).execute().data or []
        if not rows:
            break

        for row in rows:
            timings = row.get('word_timings')
            key = public_id_for(row)
            if not timings:
                # An empty array is not NULL, so it matches this pass's filter
                # and would be re-selected forever if we merely `continue`d —
                # the page never drains and the loop never ends. There is
                # nothing to upload, so retire the row by nulling it: a chapter
                # with no timings simply has no karaoke, which is already a
                # supported state.
                print(f'  – {key}: empty timings array, nulling (nothing to upload)')
                if not dry_run:
                    sb().table('audiobook_chapters').update({'word_timings': None})\
                        .eq('id', row['id']).execute()
                done += 1
                continue
            payload = json.dumps(timings, separators=(',', ':')).encode('utf-8')
            if dry_run:
                print(f'  [dry-run] would upload {key}.json  '
                      f'({len(timings)} timings, {human(len(payload))})')
                done += 1
                bytes_moved += len(payload)
                continue
            try:
                result = cloudinary.uploader.upload(
                    io.BytesIO(payload),
                    resource_type='raw',
                    folder=WORD_TIMINGS_FOLDER,
                    public_id=f'{key}.json',
                    overwrite=True,
                    invalidate=True,
                    timeout=60,
                )
                url = result.get('secure_url')
                if not url:
                    raise RuntimeError('no secure_url in Cloudinary response')
                sb().table('audiobook_chapters').update({'word_timings_url': url})\
                    .eq('id', row['id']).execute()
                done += 1
                bytes_moved += len(payload)
                print(f'  ✓ {key}  {len(timings)} timings  {human(len(payload))}')
            except Exception as exc:
                failed += 1
                print(f'  ✗ {key}: {exc}')
            time.sleep(0.05)   # be kind to the free Cloudinary tier

        if dry_run:
            break   # nothing changed, so the same page would repeat forever

    print()
    print(f'uploaded: {done}   failed: {failed}   moved: {human(bytes_moved)}')
    if failed:
        print('Re-run to retry the failures — they are still pending.')


# ── --clear ──────────────────────────────────────────────────────────────────

def cmd_clear(limit, dry_run, confirm):
    if not dry_run and not confirm:
        sys.exit(
            '[REFUSED] --clear nulls the inline timings.\n'
            '          Confirm that phase 1 IS DEPLOYED (the live backend must\n'
            '          understand word_timings_url, or every existing book\n'
            '          loses karaoke), then re-run with --confirm.'
        )

    cleared = skipped = 0
    freed = 0
    offset = 0
    while limit is None or cleared + skipped < limit:
        batch = PAGE if limit is None else min(PAGE, limit - cleared - skipped)
        q = (sb().table('audiobook_chapters')
             .select('id, audiobook_id, position, word_timings, word_timings_url')
             .not_.is_('word_timings', 'null')
             .not_.is_('word_timings_url', 'null')
             .order('id'))
        # A real run shrinks its own work queue, so it always takes the head.
        # A dry run changes nothing, so it must advance an offset or it would
        # re-check the same page forever.
        rows = (q.range(offset, offset + batch - 1) if dry_run
                else q.limit(batch)).execute().data or []
        if not rows:
            break
        if dry_run:
            offset += len(rows)

        for row in rows:
            key = public_id_for(row)
            local = row.get('word_timings')
            try:
                resp = http_requests.get(row['word_timings_url'], timeout=20)
                resp.raise_for_status()
                remote = resp.json()
            except Exception as exc:
                skipped += 1
                print(f'  ⏭ {key}: CDN copy unreadable, keeping the blob ({exc})')
                continue

            if not timings_match(local, remote):
                skipped += 1
                print(f'  ⏭ {key}: CDN copy does not match the database '
                      f'({len(remote or [])} vs {len(local or [])} timings), keeping the blob')
                continue

            size = len(json.dumps(local, separators=(',', ':')))
            if dry_run:
                print(f'  [dry-run] would clear {key}  (verified, frees {human(size)})')
                cleared += 1
                freed += size
                continue

            try:
                sb().table('audiobook_chapters').update({'word_timings': None})\
                    .eq('id', row['id']).execute()
                cleared += 1
                freed += size
                print(f'  ✓ {key}  verified, blob cleared  ({human(size)})')
            except Exception as exc:
                skipped += 1
                print(f'  ✗ {key}: clear failed: {exc}')

    print()
    print(f'cleared: {cleared}   skipped: {skipped}   freed: {human(freed)}')
    if cleared and not dry_run:
        print()
        print('Postgres does not hand freed pages back to the OS on its own, and')
        print('Supabase bills on what the OS sees. Run --vacuum-sql next, or the')
        print('dashboard number will not move.')


# ── --vacuum-sql ─────────────────────────────────────────────────────────────

def cmd_vacuum_sql():
    print("""
-- Run in the Supabase SQL Editor once --clear reports 0 pending.
--
-- VACUUM FULL rewrites the table and takes an ACCESS EXCLUSIVE lock: reads and
-- writes to audiobook_chapters block for the duration. The table is small, so
-- expect seconds, but do it at low traffic and NOT while a conversion is
-- running (chapter inserts would block):
--
--   SELECT * FROM conversion_tasks WHERE queue_status IN ('queued','processing');

-- Before:
SELECT pg_size_pretty(pg_total_relation_size('audiobook_chapters')) AS before;

VACUUM (FULL, ANALYZE) audiobook_chapters;

-- After:
SELECT pg_size_pretty(pg_total_relation_size('audiobook_chapters')) AS after;
""".strip())


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument('--status', action='store_true', help='counts and estimated reclaimable size')
    mode.add_argument('--upload', action='store_true', help='pass 1: write timings to the CDN (additive)')
    mode.add_argument('--clear', action='store_true', help='pass 2: null verified inline blobs')
    mode.add_argument('--vacuum-sql', action='store_true', help='print the SQL that reclaims the space')
    ap.add_argument('--limit', type=int, default=None, help='process at most N chapters')
    ap.add_argument('--dry-run', action='store_true', help='report without writing anything')
    ap.add_argument('--confirm', action='store_true', help='required for a real --clear')
    args = ap.parse_args()

    if args.status:
        cmd_status()
    elif args.upload:
        cmd_upload(args.limit, args.dry_run)
    elif args.clear:
        cmd_clear(args.limit, args.dry_run, args.confirm)
    else:
        cmd_vacuum_sql()


if __name__ == '__main__':
    main()
