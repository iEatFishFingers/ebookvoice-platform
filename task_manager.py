"""
Task Manager - Database abstraction for conversion task state.

All Supabase operations are wrapped with retry-on-reconnect logic to handle
HTTP/2 ConnectionTerminated errors that occur under concurrent load.
"""

import re
import time
import traceback
from typing import Optional, Dict, Any
from datetime import datetime, timedelta, timezone


# Error types that indicate a dropped HTTP/2 connection (retriable)
_CONN_ERROR_SIGNALS = ('RemoteProtocolError', 'ConnectionTerminated', 'ConnectError', 'ReadError')


def _is_conn_error(exc: Exception) -> bool:
    label = f"{type(exc).__name__} {exc}"
    return any(sig in label for sig in _CONN_ERROR_SIGNALS)


class TaskManager:
    """
    Manages conversion task state in Supabase.

    Uses dynamic client lookup (via auth.get_supabase_client) on every operation
    so that after a reset_supabase_client() call the next operation automatically
    gets a fresh HTTP connection.

    All public methods retry up to _MAX_RETRIES times on connection errors,
    resetting the singleton client between attempts.
    """

    _MAX_RETRIES = 3

    def __init__(self, supabase_client):
        # We keep the initial reference but always call _db() dynamically
        # so a reset takes effect immediately.
        _ = supabase_client  # accepted for API compatibility; not stored

    # ── Client accessor ───────────────────────────────────────────────────────

    def _db(self):
        from auth import get_supabase_client
        return get_supabase_client()

    def _run(self, fn):
        """Execute fn() with retry on connection errors, resetting client between attempts."""
        from auth import reset_supabase_client
        last_exc = None
        for attempt in range(self._MAX_RETRIES):
            try:
                return fn()
            except Exception as exc:
                if _is_conn_error(exc) and attempt < self._MAX_RETRIES - 1:
                    wait = 1.0 * (attempt + 1)
                    print(f'[TaskManager] Connection error (attempt {attempt + 1}), '
                          f'reconnecting in {wait:.0f}s: {type(exc).__name__}')
                    time.sleep(wait)
                    reset_supabase_client()
                    last_exc = exc
                    continue
                raise
        raise last_exc  # should not reach here

    # ── Public API ────────────────────────────────────────────────────────────

    # Columns that newer backend code may insert but that may be absent on
    # older deploys (PGRST204 schema-cache misses). When the insert fails on
    # one of these, we drop the column and retry once so the task still
    # enqueues — the corresponding feature just doesn't carry through to the
    # final audiobook row until the matching migration is applied.
    _OPTIONAL_COLUMNS = ('language', 'source_hash', 'is_retry', 'image_upload_id', 'device_id')

    def create_task(self, task_id: str, initial_data: Dict[str, Any]) -> bool:
        """
        Create a new task in the database.
        Accepts any columns — queue fields pass through automatically.
        """
        try:
            task_data = {'id': task_id}
            task_data.update(initial_data)
            task_data = {k: v for k, v in task_data.items() if v is not None}
            try:
                self._run(lambda: self._db().table('conversion_tasks').insert(task_data).execute())
            except Exception as insert_err:
                err_str = str(insert_err).lower()
                dropped = []
                for col in self._OPTIONAL_COLUMNS:
                    if col in err_str and col in task_data:
                        task_data.pop(col, None)
                        dropped.append(col)
                if not dropped:
                    raise
                print(f'[WARN] conversion_tasks columns missing, retrying without: {dropped}')
                self._run(lambda: self._db().table('conversion_tasks').insert(task_data).execute())
            print(f'[OK] Created task {task_id} in database')
            return True
        except Exception as e:
            print(f'[ERROR] Error creating task {task_id}: {e}')
            traceback.print_exc()
            return False

    # Sentinel returned by get_task(distinguish_errors=True) when the lookup
    # failed because the database was unreachable (e.g. a Supabase outage), as
    # opposed to the task genuinely not existing. Callers use it to answer 503
    # ("retry me") instead of 404 ("drop me") — the client drops a task after
    # 3 consecutive 404s, so misreporting an outage as 404 kills healthy tasks.
    DB_ERROR = object()

    def get_task(self, task_id: str, columns: str = '*',
                 distinguish_errors: bool = False) -> Optional[Dict[str, Any]]:
        """Get task by ID.

        With `distinguish_errors=True`, a database failure returns
        TaskManager.DB_ERROR instead of None so the caller can tell
        "DB down" apart from "task not found".

        `columns` lets hot callers request a slim projection instead of '*'.
        The /status polling path hits this every ~3s per active conversion, and
        '*' drags the multi-hundred-KB `chapters` blob out of Supabase on every
        poll — historically the dominant free-tier egress sink. Defaults to '*'
        so existing callers are unchanged.

        Self-healing: if a slim projection names a column that doesn't exist in
        this environment (schema drift — happened twice with `queue_position`
        and `voice_name`), we parse the offending column out of the error, DROP
        just that column, and retry with the still-slim projection — NOT '*'.
        Falling back to '*' would silently re-open the chapters-blob egress leak
        this projection exists to prevent. Only if we can't identify the bad
        column do we resort to '*'.
        """
        try:
            response = self._run(
                lambda: self._db().table('conversion_tasks')
                    .select(columns).eq('id', task_id).execute()
            )
            data = response.data
            return data[0] if data else None
        except Exception as e:
            err_str = str(e).lower()
            is_missing_col = 'does not exist' in err_str or '42703' in err_str
            if columns != '*' and is_missing_col:
                bad_col = self._missing_column_name(str(e))
                cols = [c.strip() for c in columns.split(',') if c.strip()]
                if bad_col and bad_col in cols:
                    cols.remove(bad_col)
                    print(f'[WARN] get_task: column "{bad_col}" missing from '
                          f'conversion_tasks — dropping it and retrying with the '
                          f'still-slim projection (no chapters blob)')
                    return self.get_task(task_id, columns=', '.join(cols),
                                         distinguish_errors=distinguish_errors)
                # Couldn't identify the column — last-resort full row.
                print(f'[WARN] get_task slim projection failed (unparseable), '
                      f'retrying with *: {e}')
                return self.get_task(task_id, columns='*',
                                     distinguish_errors=distinguish_errors)
            print(f'[ERROR] Error getting task {task_id}: {e}')
            traceback.print_exc()
            return self.DB_ERROR if distinguish_errors else None

    @staticmethod
    def _missing_column_name(err: str) -> Optional[str]:
        """Extract the column name from a Postgres 42703 'column X does not
        exist' error so the slim projection can self-trim. Handles the
        PostgREST shape 'column conversion_tasks.voice_name does not exist'."""
        m = re.search(
            r'column\s+(?:[a-z_]+\.)?["\']?([a-z_][a-z0-9_]*)["\']?\s+does not exist',
            err, re.IGNORECASE,
        )
        return m.group(1) if m else None

    def update_task(self, task_id: str, updates: Dict[str, Any]) -> bool:
        """Update task fields in the database."""
        try:
            updates = {k: v for k, v in updates.items() if v is not None}
            if not updates:
                return True
            self._run(
                lambda: self._db().table('conversion_tasks')
                    .update(updates).eq('id', task_id).execute()
            )
            return True
        except Exception as e:
            print(f'[ERROR] Error updating task {task_id}: {e}')
            traceback.print_exc()
            return False

    def task_exists(self, task_id: str) -> bool:
        return self.get_task(task_id) is not None

    def cleanup_old_tasks(self, hours: int = 24) -> int:
        """
        Delete old conversion_tasks rows to keep the table small.

        Deletes only tasks with queue_status in ('done', 'cancelled'). Failed
        tasks are KEPT — they reference CDN files (audio chunks, cover art,
        EPUB images) that may need to be reaped manually from Cloudinary,
        and the only way to know what to clean up is to inspect the failed
        task row.

        To find failed tasks you can run in Supabase SQL Editor:
            SELECT id, title, error, created_at
            FROM conversion_tasks
            WHERE queue_status = 'failed'
            ORDER BY created_at DESC;
        """
        try:
            cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
            # Count what we're about to delete (for the log line)
            before = self._run(
                lambda: self._db().table('conversion_tasks')
                    .select('id', count='exact')
                    .in_('queue_status', ['done', 'cancelled'])
                    .lt('created_at', cutoff.isoformat())
                    .execute()
            )
            count = before.count or 0
            if count > 0:
                self._run(
                    lambda: self._db().table('conversion_tasks')
                        .delete()
                        .in_('queue_status', ['done', 'cancelled'])
                        .lt('created_at', cutoff.isoformat())
                        .execute()
                )
                print(f'[OK] Cleaned up {count} done/cancelled tasks older than {hours} hours (failed tasks preserved)')
            return count
        except Exception as e:
            print(f'[ERROR] Error cleaning up tasks: {e}')
            traceback.print_exc()
            return 0

    def get_user_tasks(self, user_id: str, limit: int = 10) -> list:
        try:
            response = self._run(
                lambda: self._db().table('conversion_tasks')
                    .select('*').eq('user_id', user_id)
                    .order('created_at', desc=True).limit(limit).execute()
            )
            return response.data or []
        except Exception as e:
            print(f'[ERROR] Error getting user tasks: {e}')
            traceback.print_exc()
            return []
