"""
redeliver_failed_task.py
========================
Diagnose + redeliver a customer's silently-failed conversion.

Designed for the 2026-05-28 silent-save-loss failure mode:
- old code marked task `complete=True` with NO error
- audiobook row created with NO chapter rows (chapter INSERT batch hit 57014)
- "Audiobook Ready!" push fired
- user's library stayed empty

The fix on main (commit 16b4a0c, merged 3e4a187) handles the failure mode
going forward, but doesn't retroactively recover the lost conversions.

This script does the recovery — entirely by nudging Supabase to re-queue
the existing task row. The actual re-conversion runs ON THE SERVER
(Render's queue worker picks up the re-queued task and re-runs it against
the now-fixed per-chapter save path).

Usage
-----
Discovery (read-only):
    python scripts/redeliver_failed_task.py --email <email>

Recover (re-queue a specific failed task; also deletes same-hash orphans):
    python scripts/redeliver_failed_task.py --email <email> --requeue <task_id>

Print SQL only (run yourself in Supabase SQL Editor):
    python scripts/redeliver_failed_task.py --email <email> --requeue <task_id> --print-sql

Reads SUPABASE_URL and SUPABASE_SERVICE_KEY from .env (same as backend).
"""
import os
import sys
import argparse
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

SUPABASE_URL = os.environ.get('SUPABASE_URL')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_KEY') or os.environ.get('SUPABASE_KEY')

if not SUPABASE_URL or not SUPABASE_KEY:
    sys.exit('[ERROR] SUPABASE_URL and SUPABASE_SERVICE_KEY required in .env')

sb = create_client(SUPABASE_URL, SUPABASE_KEY)


def find_user(email):
    """Profile lookup by email. Returns dict or None."""
    res = sb.table('profiles').select('id, email, display_name').eq('email', email).limit(1).execute()
    if not res.data:
        return None
    return res.data[0]


def list_recent_tasks(user_id, limit=15):
    """User's most recent conversion_tasks rows, newest first."""
    res = sb.table('conversion_tasks').select(
        'id, title, queue_status, complete, error, created_at, '
        'started_at, completed_at, database_id, chapters, source_hash'
    ).eq('user_id', user_id).order('created_at', desc=True).limit(limit).execute()

    out = []
    for t in (res.data or []):
        chapters = t.get('chapters')
        has_payload = bool(chapters) and isinstance(chapters, list) and len(chapters) > 0
        out.append({
            'id': t['id'],
            'title': t.get('title') or '(untitled)',
            'queue_status': t.get('queue_status'),
            'complete': t.get('complete'),
            'error': t.get('error'),
            'created_at': t.get('created_at'),
            'database_id': t.get('database_id'),
            'source_hash': t.get('source_hash'),
            'chapters_count': len(chapters) if has_payload else 0,
            'has_payload': has_payload,
        })
    return out


def list_audiobooks(user_id, limit=15):
    """User's audiobooks with chapter count (joined) to spot orphans."""
    res = sb.table('audiobooks').select(
        'id, title, source_hash, status, duration, created_at, audiobook_chapters(id)'
    ).eq('user_id', user_id).order('created_at', desc=True).limit(limit).execute()

    out = []
    for ab in (res.data or []):
        chapters = ab.get('audiobook_chapters') or []
        out.append({
            'id': ab['id'],
            'title': ab.get('title') or '(untitled)',
            'source_hash': ab.get('source_hash'),
            'status': ab.get('status'),
            'duration': ab.get('duration'),
            'created_at': ab.get('created_at'),
            'chapter_count': len(chapters),
        })
    return out


def short(s, n=8):
    return (s or '')[:n] if s else '-'


def print_tasks(tasks):
    print(f"\nConversion tasks ({len(tasks)}, newest first):")
    if not tasks:
        print("  (none)")
        return
    for t in tasks:
        flag = ''
        if t['has_payload'] and t.get('complete') and not t.get('error') and not t.get('database_id'):
            flag = '  ← SILENT FAILURE; RECOVERABLE (payload intact)'
        elif not t['has_payload'] and t.get('complete') and not t.get('database_id'):
            flag = '  ← silent failure; payload GONE (cleanup ran)'
        elif t.get('database_id'):
            flag = '  ← saved OK'
        elif t.get('error'):
            flag = '  ← failed with error'
        print(f"\n  task_id:  {t['id']}{flag}")
        print(f"    title:    {t['title']}")
        print(f"    when:     {t['created_at']}")
        print(f"    status:   {t['queue_status']}   complete: {t['complete']}")
        print(f"    chapters: {t['chapters_count']}  ({'payload present' if t['has_payload'] else 'NO payload — already cleaned up'})")
        print(f"    error:    {t.get('error') or '-'}")
        print(f"    db_id:    {t.get('database_id') or '-'}")
        print(f"    hash:     {short(t.get('source_hash'))}")


def print_audiobooks(books):
    print(f"\nAudiobooks ({len(books)}, newest first):")
    if not books:
        print("  (none)")
        return
    for b in books:
        flag = '  ← ORPHAN (0 chapters)' if b['chapter_count'] == 0 else ''
        print(f"  {b['id']}  '{b['title']}'  chapters={b['chapter_count']}  duration={b.get('duration')}s  hash={short(b.get('source_hash'))}{flag}")
        print(f"    created: {b['created_at']}")


def requeue_task(task_id, user_id, source_hash, print_sql=False):
    """Re-queue a silently-failed task. Also deletes same-hash orphan
    audiobook rows so the re-conversion's source_hash dedup check doesn't
    bind to a 0-chapter ghost from the failed run."""

    orphan_ids = []
    if source_hash:
        orphans = sb.table('audiobooks').select(
            'id, title, audiobook_chapters(id)'
        ).eq('user_id', user_id).eq('source_hash', source_hash).execute()
        orphan_ids = [
            o['id'] for o in (orphans.data or [])
            if not (o.get('audiobook_chapters') or [])
        ]

    if print_sql:
        print("\n-- Run these in Supabase SQL Editor (in order):\n")
        for oid in orphan_ids:
            print(f"DELETE FROM audiobooks WHERE id = '{oid}';")
        print()
        print(f"""UPDATE conversion_tasks SET
    queue_status = 'queued',
    complete     = false,
    error        = null,
    started_at   = null,
    completed_at = null,
    progress     = 0,
    status       = 'Queued for retry (post-fix)',
    database_id  = null
  WHERE id = '{task_id}';""")
        return

    for oid in orphan_ids:
        sb.table('audiobooks').delete().eq('id', oid).execute()
        print(f"  ✂️  deleted orphan audiobook {oid}")

    sb.table('conversion_tasks').update({
        'queue_status': 'queued',
        'complete': False,
        'error': None,
        'started_at': None,
        'completed_at': None,
        'progress': 0,
        'status': 'Queued for retry (post-fix)',
        'database_id': None,
    }).eq('id', task_id).execute()
    print(f"  ↻  re-queued task {task_id}")
    print("\n✅ Done. Render's queue worker will pick this up within ~60 s.")
    print("   Watch Render logs for the new per-chapter save lines:")
    print("     💾 chapter 1/60: full")
    print("     💾 chapter 2/60: full")
    print("     [WARN] chapter N timed out — saving without word_timings  ← good (fallback worked)")
    print("     ✓ Saved audiobook ... to database for user ...")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--email', required=True, help='Customer email to look up')
    ap.add_argument('--requeue', metavar='TASK_ID', help='Re-queue this task (Render runs the re-conversion)')
    ap.add_argument('--print-sql', action='store_true', help='Print SQL instead of writing to DB (for --requeue)')
    args = ap.parse_args()

    user = find_user(args.email)
    if not user:
        sys.exit(f"[ERROR] No profile found for {args.email}")

    print(f"\nUser: {user.get('email')} ({user.get('display_name') or '(no display name)'})")
    print(f"ID:   {user['id']}")

    tasks = list_recent_tasks(user['id'])
    print_tasks(tasks)

    books = list_audiobooks(user['id'])
    print_audiobooks(books)

    if not args.requeue:
        print("\n(read-only mode — pass --requeue <task_id> to recover a silent-failure task)")
        return

    target = next((t for t in tasks if t['id'] == args.requeue), None)
    if not target:
        sys.exit(f"\n[ERROR] task {args.requeue} not in this user's most recent {len(tasks)} tasks")
    if not target['has_payload']:
        sys.exit(
            f"\n[ERROR] task {args.requeue} has no chapters payload (already cleaned up by "
            f"cleanup_old_tasks). Recovery via re-queue isn't possible.\n\n"
            f"Workaround: ask the customer to re-upload the same EPUB from their app. "
            f"Source-hash dedup means it won't count toward their monthly conversion limit."
        )
    print(f"\nRe-queueing task {args.requeue}...")
    requeue_task(args.requeue, user['id'], target['source_hash'], print_sql=args.print_sql)


if __name__ == '__main__':
    main()
