"""
queue_manager.py — Server-side conversion queue backed by Supabase.

Architecture:
  Each Gunicorn worker runs one QueueWorker thread (started in post_worker_init).
  Workers compete to claim tasks via the claim_next_queued_task Postgres RPC,
  which uses FOR UPDATE SKIP LOCKED — zero race conditions, fully atomic.

  Concurrency is enforced at two levels:
    1. SQL RPC: global limit + per-user limit checked inside the transaction
    2. QueueWorker._semaphore: each worker runs up to MAX_TASKS_PER_WORKER tasks

  With e.g. 2 Gunicorn workers × MAX_TASKS_PER_WORKER=5, you get up to 10
  concurrent conversions. edge-tts + Cloudinary are I/O-bound so threads scale
  well here — no GIL bottleneck.

  Stuck task recovery: requeue_stuck_tasks() is called on each worker startup.
  Tasks stuck in 'processing' for > STUCK_THRESHOLD_MINUTES are reset to 'queued'.
"""

import os
import threading
import time
import uuid
import logging
from datetime import datetime, timezone
from typing import Callable, Dict, Any, Set

import requests as http_requests

logger = logging.getLogger(__name__)

POLL_INTERVAL_S = 2.0
# Tuned for Render Starter (512 MB RAM). One conversion at a time per worker
# keeps total RAM usage under the limit. Additional users queue behind the
# active conversion — they see "Position N" until their turn. If you ever
# upgrade Render (Standard = 2 GB) you can raise both of these back up.
GLOBAL_CONCURRENCY_LIMIT = 1   # Max simultaneous conversions across ALL workers
MAX_TASKS_PER_WORKER = 1       # Max simultaneous conversions per Gunicorn worker
# Lower threshold so a crashed/OOM-killed task is recovered within minutes,
# not 10 min. Active workers update their tasks every few seconds during TTS,
# so anything that hasn't been touched in 2 min is genuinely dead.
STUCK_THRESHOLD_MINUTES = 2
# How often the queue worker re-runs requeue on top of the once-at-startup
# call. Without this, an OOM mid-conversion would leave the task stuck for
# the full STUCK_THRESHOLD_MINUTES before the *next* restart picks it up.
REQUEUE_SWEEP_INTERVAL_S = 60.0
# Retry cap: after this many requeues, requeue_stuck_tasks marks the task
# 'failed' instead of resurrecting it again — so a poison task (e.g. OOM,
# persistent error) fails gracefully rather than crash-looping the worker.
# Env-overridable. See migrations/009 for the matching Supabase RPC.
MAX_TASK_RETRIES = int(os.environ.get('MAX_TASK_RETRIES', '3'))

# Conversion handler registry — maps conversion_type -> callable(task_id, task_row)
_HANDLERS: Dict[str, Callable] = {}


# ── Exceptions ────────────────────────────────────────────────────────────────

class TaskCancelledError(Exception):
    """Raised when a task has been cancelled mid-processing."""
    pass


# ── Helpers ───────────────────────────────────────────────────────────────────

def _fmt_duration(seconds: float) -> str:
    seconds = int(seconds)
    if seconds < 60:
        return f"{seconds}s"
    m, s = divmod(seconds, 60)
    if m < 60:
        return f"{m}m {s}s"
    h, m = divmod(m, 60)
    return f"{h}h {m}m {s}s"


def is_task_cancelled(supabase_client, task_id: str) -> bool:
    """Return True if the task has been cancelled. Used by process functions for mid-task checks."""
    try:
        result = supabase_client.table('conversion_tasks') \
            .select('queue_status') \
            .eq('id', task_id) \
            .single() \
            .execute()
        return (result.data or {}).get('queue_status') == 'cancelled'
    except Exception:
        return False


def _send_push(supabase_client, user_id: str, title: str, body: str, data: dict) -> None:
    """Best-effort push notification — never raises."""
    try:
        result = supabase_client.table('profiles') \
            .select('expo_push_token') \
            .eq('id', user_id) \
            .single() \
            .execute()
        token = result.data.get('expo_push_token') if result.data else None
        if not token:
            return
        http_requests.post(
            'https://exp.host/--/api/v2/push/send',
            json={'to': token, 'title': title, 'body': body,
                  'sound': 'default', 'data': data},
            headers={'Accept': 'application/json', 'Content-Type': 'application/json'},
            timeout=10,
        )
    except Exception as e:
        logger.debug(f"[QueueManager] Push notification failed silently: {e}")


# ── Public API ────────────────────────────────────────────────────────────────

def register_handler(conversion_type: str, fn: Callable) -> None:
    """Register a conversion function for a given conversion_type string."""
    _HANDLERS[conversion_type] = fn
    logger.info(f"[QueueManager] Registered handler for type '{conversion_type}'")


def enqueue_task(task_manager, task_id: str, initial_data: Dict[str, Any],
                 supabase_client=None) -> bool:
    """
    Create a new task in 'queued' state.
    Sends a 'queued' push notification if user_id is present.
    """
    data = {
        **initial_data,
        'queue_status': 'queued',
        'queued_at': datetime.now(timezone.utc).isoformat(),
    }
    success = task_manager.create_task(task_id, data)

    if success and supabase_client and initial_data.get('user_id'):
        _send_push(
            supabase_client,
            user_id=initial_data['user_id'],
            title='Conversion Queued',
            body=f'"{initial_data.get("title", "Your audiobook")}" is in the queue.',
            data={'task_id': task_id, 'event': 'queued'},
        )

    return success


def requeue_stuck_tasks(supabase_client) -> int:
    """
    Call once on each worker startup to recover tasks orphaned by a previous crash.
    Returns the number of tasks requeued.
    """
    try:
        result = supabase_client.rpc(
            'requeue_stuck_tasks',
            {
                'p_stuck_threshold_minutes': STUCK_THRESHOLD_MINUTES,
                # After this many requeues, the RPC auto-fails the task instead
                # of resurrecting it (poison-task / crash-loop protection).
                'p_max_retries': MAX_TASK_RETRIES,
            },
        ).execute()
        count = result.data or 0
        if count:
            logger.warning(f"[QueueManager] Requeued {count} stuck task(s) from previous crash")
        return count
    except Exception as e:
        logger.error(f"[QueueManager] requeue_stuck_tasks failed: {e}")
        return 0


# ── Worker ────────────────────────────────────────────────────────────────────

class QueueWorker:
    """
    Long-lived background thread that claims and runs queued conversion tasks.
    One instance per Gunicorn worker process, started from gunicorn.conf.py.

    Supports up to MAX_TASKS_PER_WORKER concurrent conversions via a semaphore.
    The poll loop fills all available slots each cycle.
    """

    def __init__(self, supabase_client):
        self.supabase = supabase_client
        self.worker_id = str(uuid.uuid4())[:12]
        self._stop = threading.Event()
        # Semaphore limits concurrent tasks within this worker process
        self._semaphore = threading.Semaphore(MAX_TASKS_PER_WORKER)
        # Track active task IDs for logging
        self._active_tasks: Set[str] = set()
        self._active_lock = threading.Lock()
        # Last time we ran requeue_stuck_tasks from inside the loop
        self._last_requeue_sweep: float = 0.0
        self._thread = threading.Thread(
            target=self._loop,
            name=f'QueueWorker-{self.worker_id}',
            daemon=True,
        )

    def start(self) -> None:
        print(f"[QueueWorker {self.worker_id}] Starting "
              f"(max {MAX_TASKS_PER_WORKER} concurrent, global limit {GLOBAL_CONCURRENCY_LIMIT})")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    # ── Internal ──────────────────────────────────────────────────────────────

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                # Periodically requeue any task that died mid-conversion (OOM,
                # network drop, etc.). Without this, a stuck "processing" task
                # eats one of the global slots and blocks every later upload
                # until the *next* restart's startup sweep runs.
                now = time.monotonic()
                if now - self._last_requeue_sweep >= REQUEUE_SWEEP_INTERVAL_S:
                    self._last_requeue_sweep = now
                    try:
                        requeue_stuck_tasks(self.supabase)
                    except Exception as sweep_err:
                        logger.warning(
                            f"[QueueWorker {self.worker_id}] Mid-loop requeue sweep failed: {sweep_err}"
                        )

                # Try to fill all available slots each poll cycle
                while self._try_claim_and_dispatch():
                    pass
            except Exception as e:
                logger.error(f"[QueueWorker {self.worker_id}] Loop error: {e}", exc_info=True)
            self._stop.wait(timeout=POLL_INTERVAL_S)

    def _try_claim_and_dispatch(self) -> bool:
        """
        Attempt to claim one task from the queue.
        Returns True if a task was claimed (caller should try again to fill more slots),
        False if no task was available or all slots are full.
        """
        # Try to acquire a worker slot (non-blocking)
        if not self._semaphore.acquire(blocking=False):
            return False  # All slots in this worker are full

        # Atomically claim the next eligible task via Postgres RPC
        try:
            result = self.supabase.rpc(
                'claim_next_queued_task',
                {'p_worker_id': self.worker_id,
                 'p_global_limit': GLOBAL_CONCURRENCY_LIMIT},
            ).execute()
        except Exception as e:
            self._semaphore.release()
            logger.warning(f"[QueueWorker {self.worker_id}] RPC error: {e}")
            return False

        rows = result.data or []
        if not rows:
            self._semaphore.release()
            return False  # Queue empty

        task_row = rows[0]
        task_id = task_row['id']
        conversion_type = task_row.get('conversion_type', 'chapters')

        handler = _HANDLERS.get(conversion_type)
        if not handler:
            self._semaphore.release()
            logger.error(f"[QueueWorker {self.worker_id}] No handler for '{conversion_type}', task {task_id}")
            self._mark_failed(task_id, f"Unknown conversion type: {conversion_type}")
            return False

        with self._active_lock:
            self._active_tasks.add(task_id)

        active_count = len(self._active_tasks)
        print(f"[QueueWorker {self.worker_id}] Claimed task {task_id} "
              f"(type={conversion_type}, title={task_row.get('title', 'unknown')!r}) "
              f"[{active_count} active]")

        # Send "started" push notification
        user_id = task_row.get('user_id')
        if user_id:
            _send_push(
                self.supabase, user_id=user_id,
                title='Conversion Started 🎙️',
                body=f'"{task_row.get("title", "Your audiobook")}" is now being converted.',
                data={'task_id': task_id, 'event': 'started'},
            )

        # Dispatch in a child thread — semaphore released in _run_task's finally
        threading.Thread(
            target=self._run_task,
            args=(task_id, task_row, handler),
            name=f'Conversion-{task_id[:16]}',
            daemon=True,
        ).start()

        return True  # Slot claimed — caller may try for another

    def _run_task(self, task_id: str, task_row: Dict[str, Any], handler: Callable) -> None:
        title = task_row.get('title') or task_id
        conv_type = task_row.get('conversion_type', 'unknown')
        start = time.time()

        print(f"\n{'━'*60}")
        print(f"  ▶  CONVERSION STARTED")
        print(f"     Title   : {title}")
        print(f"     Task ID : {task_id}")
        print(f"     Type    : {conv_type}  |  Worker: {self.worker_id}")
        with self._active_lock:
            print(f"     Active  : {len(self._active_tasks)} concurrent")
        print(f"{'━'*60}\n")

        try:
            handler(task_id, task_row)

            # Don't overwrite state if cancelled while processing
            if is_task_cancelled(self.supabase, task_id):
                elapsed = time.time() - start
                print(f"\n{'━'*60}")
                print(f"  ✖  CONVERSION CANCELLED  ({_fmt_duration(elapsed)})")
                print(f"     Title   : {title}")
                print(f"{'━'*60}\n")
                return

            self._mark_done(task_id)
            elapsed = time.time() - start
            print(f"\n{'━'*60}")
            print(f"  ✔  CONVERSION COMPLETE  ({_fmt_duration(elapsed)})")
            print(f"     Title   : {title}")
            print(f"{'━'*60}\n")

        except TaskCancelledError:
            elapsed = time.time() - start
            print(f"\n{'━'*60}")
            print(f"  ✖  CONVERSION CANCELLED  ({_fmt_duration(elapsed)})")
            print(f"     Title   : {title}")
            print(f"{'━'*60}\n")

        except Exception as e:
            elapsed = time.time() - start
            print(f"\n{'━'*60}")
            print(f"  ✖  CONVERSION FAILED  ({_fmt_duration(elapsed)})")
            print(f"     Title   : {title}")
            print(f"     Error   : {e}")
            print(f"{'━'*60}\n")
            logger.error(f"[QueueWorker {self.worker_id}] Task {task_id} failed: {e}", exc_info=True)
            self._mark_failed(task_id, str(e))

        finally:
            with self._active_lock:
                self._active_tasks.discard(task_id)
            self._semaphore.release()

    def _mark_done(self, task_id: str) -> None:
        try:
            self.supabase.table('conversion_tasks') \
                .update({'queue_status': 'done'}) \
                .eq('id', task_id) \
                .execute()
        except Exception as e:
            logger.error(f"[QueueWorker] _mark_done failed for {task_id}: {e}")

    def _mark_failed(self, task_id: str, error: str) -> None:
        try:
            self.supabase.table('conversion_tasks') \
                .update({'queue_status': 'failed', 'error': error, 'complete': True}) \
                .eq('id', task_id) \
                .execute()
        except Exception as e:
            logger.error(f"[QueueWorker] _mark_failed failed for {task_id}: {e}")
