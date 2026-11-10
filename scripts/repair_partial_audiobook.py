#!/usr/bin/env python3
"""
repair_partial_audiobook.py — fill in the chapters a partial conversion lost.

Built for the 2026-10-16 edge-tts throttle failure mode:

  * The 403/attestation outage is fixed (edge-tts 7.3.1), but at
    max_workers=4 Microsoft throttles and returns NoAudioReceived — "No audio
    was received. Please verify that your parameters are correct."
  * There is NO synthesis-level retry (epub_to_audio.py:2358 returns on the
    first exception), so a throttled chapter is lost permanently.
  * completed_count increments on failure too, so the task reports
    "77/77 chapters done" and saves SUCCESSFULLY with only the survivors.
  * Result: an audiobook marked `completed` that is missing most of its
    chapters, with no error anywhere. The user finds out by hitting a gap.

This script repairs such a book IN PLACE: it synthesizes only the missing
positions locally (where we control concurrency and can retry), uploads them,
and inserts the missing chapter rows. Existing good chapters are never touched.

Why local: the server is still on max_workers=4 until that fix ships, so
re-queueing there would just reproduce the throttle. Locally we run 2 parallel
— the prod-proven level, per the 2026-05-27 note that 4x was *slower* net —
with real retries and backoff.

Safety:
  * DISABLE_QUEUE_WORKER is set BEFORE importing the app, so this process can
    never claim a real user's queued conversion.
  * Resumable: every finished chapter is checkpointed to a local manifest, so
    a crash or Ctrl-C costs nothing. Re-running skips what is already done.
  * Idempotent: positions already present in the DB are skipped, so it can
    never duplicate a chapter.
  * Does NOT increment the user's conversion count — this is our failure.
  * Defaults to DRY RUN. --execute to actually synthesize and write.

Usage:
  python scripts/repair_partial_audiobook.py --task <task_id> --snapshot <file.json>
  python scripts/repair_partial_audiobook.py --task <task_id> --snapshot <file.json> --execute

The snapshot is a JSON array (as returned by
  GET /rest/v1/conversion_tasks?id=eq.<task_id>&select=*
) captured while the task still held all chapters WITH their text. Take it
BEFORE the task's save step, which overwrites `chapters` with only the
survivors. Without it the source text for the lost chapters is gone.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

# MUST precede the epub_to_audio import: otherwise this process starts a queue
# worker and competes with Render for real users' conversions.
os.environ.setdefault('DISABLE_QUEUE_WORKER', 'true')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
sys.path.insert(0, REPO_ROOT)

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(REPO_ROOT, '.env'))
except ImportError:
    pass

from epub_to_audio import (  # noqa: E402
    get_supabase_client,
    create_chapter_audio_with_timings,
    upload_word_timings,
)
import cloudinary.uploader  # noqa: E402  (configured by importing epub_to_audio)

PARALLEL = int(os.environ.get('REPAIR_PARALLEL', '2'))
MAX_ATTEMPTS = int(os.environ.get('REPAIR_ATTEMPTS', '4'))
BACKOFF_BASE_S = float(os.environ.get('REPAIR_BACKOFF', '5'))


def manifest_path(task_id: str) -> str:
    return os.path.join(REPO_ROOT, f'repair_{task_id}.json')


def load_manifest(task_id: str) -> dict:
    p = manifest_path(task_id)
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f)
    return {'done': {}}


def save_manifest(task_id: str, m: dict) -> None:
    p = manifest_path(task_id)
    tmp = p + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(m, f, indent=1)
    os.replace(tmp, p)


def synth_one(position: int, chapter: dict, voice_id: str, audiobook_id: str) -> dict:
    """
    Synthesize + upload one chapter. Retries on throttle (NoAudioReceived) with
    exponential backoff — the whole point of doing this locally.
    """
    text = (chapter.get('content') or '').strip()
    if not text:
        raise ValueError(f'position {position} has no text in the snapshot')

    last_err = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        audio_path = os.path.join(
            tempfile.gettempdir(), f'repair_{os.getpid()}_{position}_{attempt}.mp3')
        try:
            word_timings, _emotion = create_chapter_audio_with_timings(
                text, audio_path, voice_id, use_emotional_director=False,
            )
            if not os.path.exists(audio_path) or os.path.getsize(audio_path) == 0:
                raise IOError('no audio produced')

            up = cloudinary.uploader.upload(audio_path, resource_type='video')
            duration = up.get('duration', 0) or 0

            timings_url = None
            if word_timings:
                timings_url = upload_word_timings(
                    word_timings, f'{audiobook_id}_{position}')

            return {
                'position': position,
                'chapter_id': chapter.get('id', str(position + 1)),
                'title': chapter.get('title', f'Chapter {position + 1}'),
                'audio_url': up['secure_url'],
                'duration': duration,
                'word_timings': None if timings_url else word_timings,
                'word_timings_url': timings_url,
                'image_inserts': chapter.get('imageInserts') or None,
                'words': len(text.split()),
                'attempts': attempt,
            }
        except Exception as e:
            last_err = e
            msg = str(e)[:70]
            if attempt < MAX_ATTEMPTS:
                wait = BACKOFF_BASE_S * (2 ** (attempt - 1))
                print(f'    [{position + 1}] attempt {attempt}/{MAX_ATTEMPTS} failed '
                      f'({msg}) — retrying in {wait:.0f}s')
                time.sleep(wait)
            else:
                print(f'    [{position + 1}] GAVE UP after {MAX_ATTEMPTS}: {msg}')
        finally:
            if os.path.exists(audio_path):
                os.unlink(audio_path)

    raise RuntimeError(f'position {position} failed {MAX_ATTEMPTS}x: {last_err}')


def insert_chapter(supabase, audiobook_id: str, entry: dict) -> None:
    """
    Insert one chapter row. Mirrors prod's two-stage fallback: on a Supabase
    statement timeout (57014) from a large inline timings blob, retry without
    it — audio still plays, karaoke degrades for that chapter only.
    """
    row = {
        'audiobook_id': audiobook_id,
        'chapter_id': entry['chapter_id'],
        'title': entry['title'],
        'position': entry['position'],
        'audio_url': entry['audio_url'],
        'duration': entry.get('duration', 0),
        'word_timings': entry.get('word_timings'),
        'image_inserts': entry.get('image_inserts'),
    }
    if entry.get('word_timings_url'):
        row['word_timings_url'] = entry['word_timings_url']
    try:
        supabase.table('audiobook_chapters').insert(row).execute()
    except Exception as e:
        if '57014' not in str(e):
            raise
        print(f'    [{entry["position"] + 1}] 57014 timeout — retrying without '
              f'inline timings')
        row['word_timings'] = None
        supabase.table('audiobook_chapters').insert(row).execute()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--task', required=True, help='conversion_tasks.id')
    ap.add_argument('--snapshot', required=True,
                    help='JSON snapshot of the task taken BEFORE its save step')
    ap.add_argument('--audiobook', default=None,
                    help='audiobooks.id to repair (default: newest matching the task title)')
    ap.add_argument('--execute', action='store_true',
                    help='Actually synthesize and write. Default is a dry run.')
    args = ap.parse_args()

    print('=' * 72)
    print('Partial-audiobook repair', '(DRY RUN)' if not args.execute else '(EXECUTING)')
    print('=' * 72)

    with open(args.snapshot) as f:
        snap = json.load(f)
    task = snap[0] if isinstance(snap, list) else snap
    chapters = task.get('chapters') or []
    voice_id = task.get('voice_id')
    user_id = task.get('user_id')
    title = task.get('title')

    empty = [i for i, c in enumerate(chapters) if not (c.get('content') or '').strip()]
    print(f'\nSnapshot : {len(chapters)} chapters, voice={voice_id}')
    print(f'           title={title!r}')
    print(f'           user={user_id}')
    if empty:
        print(f'  ! {len(empty)} snapshot chapters have no text: {empty}')
    if not chapters or not voice_id:
        print('✗ Snapshot is missing chapters or voice_id — cannot repair.')
        return 1

    supabase = get_supabase_client()
    if not supabase:
        print('✗ Supabase client unavailable — check env vars.')
        return 1

    audiobook_id = args.audiobook
    if not audiobook_id:
        res = supabase.table('audiobooks') \
            .select('id, title, created_at') \
            .eq('user_id', user_id) \
            .order('created_at', desc=True) \
            .limit(10).execute()
        cands = [r for r in (res.data or []) if r.get('title') == title]
        if not cands:
            print(f'✗ No audiobook found for this user with title {title!r}.')
            print('  The conversion may not have saved yet. Wait, then re-run.')
            print('  Recent audiobooks for this user:')
            for r in (res.data or []):
                print(f'    {r["id"]}  {r.get("created_at", "")[:19]}  {r.get("title")!r}')
            return 1
        audiobook_id = cands[0]['id']
        print(f'\nAudiobook: {audiobook_id} (newest matching the title)')
    else:
        print(f'\nAudiobook: {audiobook_id} (given)')

    existing = supabase.table('audiobook_chapters') \
        .select('position, title, audio_url') \
        .eq('audiobook_id', audiobook_id).execute().data or []
    have = {r['position'] for r in existing}
    broken = [r['position'] for r in existing if not r.get('audio_url')]
    missing = [i for i in range(len(chapters)) if i not in have and i not in empty]

    print(f'           {len(existing)} chapter rows present, '
          f'{len(missing)} missing, {len(broken)} present-but-no-audio')
    if broken:
        print(f'  ! rows with no audio_url (not repaired by this script): {broken}')

    if not missing:
        print('\nNothing missing. ✓')
        return 0

    words = sum(len((chapters[i].get('content') or '').split()) for i in missing)
    print(f'\nMISSING POSITIONS ({len(missing)}) — 0-indexed, chapter number = +1:')
    for i in missing:
        t = (chapters[i].get('title') or '')[:38]
        w = len((chapters[i].get('content') or '').split())
        print(f'   pos {i:3} (ch {i + 1:3})  {t:40} {w:6} words')
    print(f'\nTotal to synthesize: {len(missing)} chapters, {words:,} words')
    print(f'Concurrency: {PARALLEL}   retries per chapter: {MAX_ATTEMPTS} '
          f'(backoff {BACKOFF_BASE_S:g}s, doubling)')

    if not args.execute:
        print('\nDry run only. Re-run with --execute to synthesize and write.')
        return 0

    manifest = load_manifest(args.task)
    already = {int(k) for k in manifest['done']}
    todo = [i for i in missing if i not in already]
    if already:
        print(f'\nResuming: {len(already)} already done in manifest, {len(todo)} to go')

    print(f'\nSynthesizing {len(todo)} chapter(s)…')
    ok, failed = 0, []
    with ThreadPoolExecutor(max_workers=PARALLEL) as pool:
        futs = {
            pool.submit(synth_one, i, chapters[i], voice_id, audiobook_id): i
            for i in todo
        }
        for fut in as_completed(futs):
            i = futs[fut]
            try:
                entry = fut.result()
            except Exception as e:
                failed.append(i)
                print(f'  ✗ pos {i} (ch {i + 1}): {str(e)[:90]}')
                continue
            insert_chapter(supabase, audiobook_id, entry)
            manifest['done'][str(i)] = {
                'audio_url': entry['audio_url'],
                'word_timings_url': entry.get('word_timings_url'),
                'duration': entry.get('duration'),
                'attempts': entry['attempts'],
            }
            save_manifest(args.task, manifest)
            ok += 1
            print(f'  ✓ pos {i} (ch {i + 1}) {entry["title"][:30]!r} '
                  f'{entry["duration"]:.0f}s, {entry["attempts"]} attempt(s) '
                  f'[{ok}/{len(todo)}]')

    final = supabase.table('audiobook_chapters') \
        .select('position').eq('audiobook_id', audiobook_id).execute().data or []
    print(f'\n✓ Repaired {ok} chapter(s). Audiobook now has {len(final)} / '
          f'{len(chapters)} chapters.')
    if failed:
        print(f'! Still missing {len(failed)}: {sorted(failed)}')
        print('  Re-run the same command — the manifest means finished chapters '
              'are not redone.')
        return 1
    gaps = [i for i in range(len(chapters)) if i not in {r['position'] for r in final}
            and i not in empty]
    if gaps:
        print(f'! Remaining gaps: {gaps}')
        return 1
    print('  No gaps. The book is complete. ✓')
    return 0


if __name__ == '__main__':
    sys.exit(main())
