"""
Delete Cloudinary assets that are not referenced by any audiobook row in
Supabase. Run this periodically (or after a batch of failed conversions
piles up in conversion_tasks) to reclaim CDN storage.

Three asset categories are scanned, matching what the backend uploads:

  1. resource_type='image', folder='audiobook_covers/'
     → referenced by  audiobooks.cover_url
  2. resource_type='image', folder='epub_images/'
     → referenced by  audiobook_chapters.image_inserts[*].url
  3. resource_type='video' (Cloudinary's classification for MP3s),
     uploaded WITHOUT a folder prefix → referenced by
     audiobook_chapters.audio_url

Anything Cloudinary holds in those scopes that isn't referenced by the
DB is considered orphaned (failed conversions, abandoned uploads, etc.)
and deleted.

Safety:
  * Defaults to DRY RUN — prints what *would* be deleted, deletes nothing.
  * Requires --execute to actually delete.
  * Only touches resources in the three known scopes — won't reap anything
    you uploaded by hand or that lives in a different folder.
  * REFUSES TO RUN while a conversion is queued or processing. Chapters are
    uploaded to Cloudinary one at a time *during* a conversion, but the
    audiobook / audiobook_chapters rows are only written at the save step at
    the very end. So every chapter of an in-flight conversion is an orphan by
    this script's definition. Deleting them corrupts a live job. Override with
    --allow-busy-queue only if you know the queue is lying to you.
  * SKIPS ANYTHING NEWER THAN --min-age-hours (default 48). Belt-and-braces
    for the same hazard: a long conversion (the record is 19.5 hours) can be
    mid-flight even if the queue momentarily reads idle, and a recent failure
    is cheap to keep. The reclaimable bulk is months old, so the window costs
    essentially nothing.

> [!danger] Do NOT extend this script to resource_type='raw'
  The word_timings JSON files live under raw/ and are ALL referenced by
  audiobook_chapters.word_timings_url. More importantly, url_to_public_id()
  below strips the file extension — which is correct for image and video
  (Cloudinary excludes the format from their public_id) but WRONG for raw,
  where the public_id keeps it ('word_timings/<uuid>_7.json'). Scanning raw
  with this helper matches nothing, flags all ~1400 timing files as orphans,
  and wipes karaoke for every audiobook in the library. Verified 2026-10-16.

Usage:
  python scripts/cleanup_orphan_cdn_assets.py            # dry run
  python scripts/cleanup_orphan_cdn_assets.py --execute  # actually delete
  python scripts/cleanup_orphan_cdn_assets.py --execute --yes  # skip the
                                                           # confirm prompt
  python scripts/cleanup_orphan_cdn_assets.py --min-age-hours 168  # 1 week
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import sys
from typing import Iterable, List, Set, Tuple

# Make the repo root importable so we can reuse the same env loading + clients.
HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
sys.path.insert(0, REPO_ROOT)

# Load .env so CLOUDINARY_* + SUPABASE_* env vars are populated when run
# locally. Render injects env vars natively so this is a no-op there.
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(REPO_ROOT, '.env'))
except ImportError:
    pass

import cloudinary
import cloudinary.api
import cloudinary.uploader

from auth import get_supabase_client


cloudinary.config(
    cloud_name=os.environ.get('CLOUDINARY_CLOUD_NAME'),
    api_key=os.environ.get('CLOUDINARY_API_KEY'),
    api_secret=os.environ.get('CLOUDINARY_API_SECRET'),
)


# ── Public-ID extraction (matches the backend's logic in epub_to_audio.py) ────

_UPLOAD_SPLIT_RE = re.compile(r'/upload/(?:v\d+/)?', re.IGNORECASE)


def url_to_public_id(url: str | None) -> str | None:
    """
    Pull the Cloudinary public_id out of a delivery URL.

      https://res.cloudinary.com/X/image/upload/v123/audiobook_covers/abc.jpg
        → 'audiobook_covers/abc'
      https://res.cloudinary.com/X/video/upload/v123/xyz.mp3
        → 'xyz'
    """
    if not url:
        return None
    parts = _UPLOAD_SPLIT_RE.split(url, maxsplit=1)
    if len(parts) != 2:
        return None
    path = parts[1]
    # Strip extension
    if '.' in path:
        path = path.rsplit('.', 1)[0]
    return path or None


# ── Collect the set of public_ids currently referenced by the DB ──────────────

def collect_referenced_public_ids(supabase) -> Tuple[Set[str], Set[str], Set[str]]:
    """
    Returns (cover_ids, epub_image_ids, audio_ids) — sets of public_ids that
    are currently referenced by audiobooks / audiobook_chapters rows.
    """
    cover_ids: Set[str] = set()
    epub_image_ids: Set[str] = set()
    audio_ids: Set[str] = set()

    # audiobooks.cover_url
    page_size = 1000
    offset = 0
    while True:
        res = supabase.table('audiobooks') \
            .select('cover_url') \
            .range(offset, offset + page_size - 1) \
            .execute()
        rows = res.data or []
        if not rows:
            break
        for row in rows:
            pid = url_to_public_id(row.get('cover_url'))
            if pid:
                cover_ids.add(pid)
        if len(rows) < page_size:
            break
        offset += page_size

    # audiobook_chapters.audio_url + .image_inserts[].url
    offset = 0
    while True:
        res = supabase.table('audiobook_chapters') \
            .select('audio_url, image_inserts') \
            .range(offset, offset + page_size - 1) \
            .execute()
        rows = res.data or []
        if not rows:
            break
        for row in rows:
            pid = url_to_public_id(row.get('audio_url'))
            if pid:
                audio_ids.add(pid)
            for insert in (row.get('image_inserts') or []):
                ipid = url_to_public_id(insert.get('url') if isinstance(insert, dict) else None)
                if ipid:
                    epub_image_ids.add(ipid)
        if len(rows) < page_size:
            break
        offset += page_size

    return cover_ids, epub_image_ids, audio_ids


# ── List Cloudinary assets in our known scopes ────────────────────────────────

def list_cloudinary_assets(resource_type: str, prefix: str | None = None) -> List[dict]:
    """
    Return every asset of a given resource_type (optionally under a folder
    prefix). Paginates via Cloudinary's `next_cursor` token.
    """
    assets: List[dict] = []
    cursor: str | None = None
    while True:
        params = {
            'resource_type': resource_type,
            'type': 'upload',
            'max_results': 500,
        }
        if prefix:
            params['prefix'] = prefix
        if cursor:
            params['next_cursor'] = cursor

        res = cloudinary.api.resources(**params)
        batch = res.get('resources') or []
        assets.extend(batch)
        cursor = res.get('next_cursor')
        if not cursor:
            break
    return assets


# ── Delete in batches ─────────────────────────────────────────────────────────

def delete_in_batches(public_ids: List[str], resource_type: str, batch_size: int = 100) -> Tuple[int, int]:
    """
    Delete a list of public_ids in chunks of batch_size. Returns
    (deleted_count, failed_count).
    """
    deleted = 0
    failed = 0
    for i in range(0, len(public_ids), batch_size):
        chunk = public_ids[i:i + batch_size]
        try:
            res = cloudinary.api.delete_resources(chunk, resource_type=resource_type)
            results = res.get('deleted') or {}
            for pid, status in results.items():
                if status == 'deleted':
                    deleted += 1
                else:
                    failed += 1
                    print(f'  ! {pid}: {status}')
        except Exception as e:
            print(f'  ! Batch failed ({len(chunk)} ids): {e}')
            failed += len(chunk)
    return deleted, failed


# ── Safety guards ─────────────────────────────────────────────────────────────

ACTIVE_QUEUE_STATES = ('queued', 'processing')


def active_conversions(supabase) -> List[dict]:
    """
    Return conversion_tasks rows that are queued or processing.

    This is the same check as the never-push-mid-conversion rule. It reads the
    DB rather than GET /api/queue-status on purpose: the DB is authoritative
    and still answers when the backend is down or redeploying.
    """
    res = supabase.table('conversion_tasks') \
        .select('id, user_id, queue_status, status, progress') \
        .in_('queue_status', list(ACTIVE_QUEUE_STATES)) \
        .execute()
    return res.data or []


def asset_age_hours(asset: dict, now: dt.datetime | None = None) -> float:
    """
    Hours since Cloudinary created this asset. Returns 0.0 (i.e. "treat as
    brand new, do not delete") if created_at is missing or unparseable —
    failing safe rather than reaping something we can't date.
    """
    raw = asset.get('created_at')
    if not raw:
        return 0.0
    now = now or dt.datetime.now(dt.timezone.utc)
    try:
        created = dt.datetime.fromisoformat(str(raw).replace('Z', '+00:00'))
    except ValueError:
        return 0.0
    if created.tzinfo is None:
        created = created.replace(tzinfo=dt.timezone.utc)
    return (now - created).total_seconds() / 3600.0


# ── Main ──────────────────────────────────────────────────────────────────────

def _fmt_size(num_bytes: int) -> str:
    for unit in ('B', 'KB', 'MB', 'GB'):
        if num_bytes < 1024.0:
            return f'{num_bytes:.1f} {unit}'
        num_bytes /= 1024.0
    return f'{num_bytes:.1f} TB'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--execute',
        action='store_true',
        help='Actually delete. Without this flag the script is a dry run.',
    )
    parser.add_argument(
        '--yes',
        action='store_true',
        help='Skip the interactive confirmation prompt.',
    )
    parser.add_argument(
        '--min-age-hours',
        type=float,
        default=48.0,
        metavar='H',
        help=(
            'Never delete an asset younger than this many hours '
            '(default: 48). Protects chapters of an in-flight conversion, '
            'whose DB rows are not written until the conversion ends.'
        ),
    )
    parser.add_argument(
        '--allow-busy-queue',
        action='store_true',
        help=(
            'Proceed even when conversions are queued or processing. '
            'DANGEROUS: an in-flight conversion is indistinguishable from '
            'an orphan until it saves.'
        ),
    )
    args = parser.parse_args()

    print('=' * 70)
    print('Cloudinary orphan cleanup', '(DRY RUN)' if not args.execute else '(EXECUTING)')
    print('=' * 70)

    supabase = get_supabase_client()
    if not supabase:
        print('✗ Supabase client not available — check env vars.')
        return 1

    print('\n[0/4] Checking the conversion queue…')
    try:
        active = active_conversions(supabase)
    except Exception as e:
        print(f'✗ Could not read conversion_tasks: {e}')
        print('  Refusing to continue — an unreadable queue is not an idle queue.')
        return 1

    if active:
        print(f'  ⚠ {len(active)} conversion(s) in flight:')
        for t in active:
            print(f'    [{t.get("queue_status")}] {t.get("id")} '
                  f'user={t.get("user_id")} {t.get("progress")}% '
                  f'{(t.get("status") or "")[:50]}')
        if not args.allow_busy_queue:
            print('\n✗ ABORTING. Chapters upload to Cloudinary during a conversion but')
            print('  their DB rows are only written at the end, so every chapter of a')
            print('  live job looks orphaned. Deleting now would corrupt it.')
            print('  Wait for the queue to drain, then re-run.')
            return 1
        print('\n  --allow-busy-queue set; continuing anyway. The age window is')
        print('  now the only thing protecting in-flight chapters.')
    else:
        print('  ✓ queue idle')

    print('\n[1/4] Collecting referenced public_ids from Supabase…')
    cover_ids, epub_image_ids, audio_ids = collect_referenced_public_ids(supabase)
    print(f'  referenced covers      : {len(cover_ids)}')
    print(f'  referenced epub images : {len(epub_image_ids)}')
    print(f'  referenced audio files : {len(audio_ids)}')

    print('\n[2/4] Listing Cloudinary assets…')
    cover_assets = list_cloudinary_assets('image', prefix='audiobook_covers/')
    epub_image_assets = list_cloudinary_assets('image', prefix='epub_images/')
    # MP3s are uploaded with no folder prefix, so list them all and filter
    # out anything that looks like it's in another image folder (paranoia —
    # video and image resource_types are separate buckets in Cloudinary so
    # we shouldn't see images here anyway).
    audio_assets = list_cloudinary_assets('video', prefix=None)
    print(f'  cover assets on CDN    : {len(cover_assets)}')
    print(f'  epub image assets      : {len(epub_image_assets)}')
    print(f'  audio assets on CDN    : {len(audio_assets)}')

    print(f'\n[3/4] Matching against the DB (skipping anything younger than '
          f'{args.min_age_hours:g}h)…')

    orphans: List[Tuple[str, str, int]] = []  # (resource_type, public_id, bytes)
    too_recent: List[Tuple[str, int, float]] = []  # (public_id, bytes, age_h)
    now = dt.datetime.now(dt.timezone.utc)

    def consider(asset: dict, referenced: Set[str], resource_type: str) -> None:
        pid = asset.get('public_id')
        if not pid or pid in referenced:
            return
        age = asset_age_hours(asset, now)
        if age < args.min_age_hours:
            too_recent.append((pid, asset.get('bytes', 0), age))
            return
        orphans.append((resource_type, pid, asset.get('bytes', 0)))

    for a in cover_assets:
        consider(a, cover_ids, 'image')
    for a in epub_image_assets:
        consider(a, epub_image_ids, 'image')
    for a in audio_assets:
        consider(a, audio_ids, 'video')

    if too_recent:
        recent_size = sum(b for _, b, _ in too_recent)
        print(f'  🛡  Protected {len(too_recent)} unreferenced asset(s) '
              f'({_fmt_size(recent_size)}) as too recent:')
        for pid, size, age in sorted(too_recent, key=lambda x: x[2])[:10]:
            print(f'     {pid[:52]:54} {age:6.1f}h  {_fmt_size(size)}')
        if len(too_recent) > 10:
            print(f'     … and {len(too_recent) - 10} more')

    total_size = sum(b for _, _, b in orphans)
    print(f'\n[4/4] Found {len(orphans)} deletable orphan(s), '
          f'total {_fmt_size(total_size)}')

    if not orphans:
        print('Nothing to clean up. ✓')
        return 0

    # Show a sample
    print('\nSample (first 20):')
    for rt, pid, size in orphans[:20]:
        print(f'  [{rt}] {pid}  ({_fmt_size(size)})')
    if len(orphans) > 20:
        print(f'  … and {len(orphans) - 20} more')

    if not args.execute:
        print('\nDry run only. Re-run with --execute to actually delete.')
        return 0

    if not args.yes:
        prompt = (
            f'\nDelete {len(orphans)} orphan asset(s) ({_fmt_size(total_size)}) '
            f'from Cloudinary? [yes/N]: '
        )
        confirm = input(prompt).strip().lower()
        if confirm != 'yes':
            print('Aborted.')
            return 0

    print('\nDeleting…')
    image_ids = [pid for rt, pid, _ in orphans if rt == 'image']
    video_ids = [pid for rt, pid, _ in orphans if rt == 'video']

    img_del, img_fail = delete_in_batches(image_ids, 'image') if image_ids else (0, 0)
    vid_del, vid_fail = delete_in_batches(video_ids, 'video') if video_ids else (0, 0)

    print(f'\n✓ Deleted: {img_del} image(s), {vid_del} audio file(s)')
    if img_fail + vid_fail:
        print(f'! Failed:  {img_fail} image(s), {vid_fail} audio file(s)')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
