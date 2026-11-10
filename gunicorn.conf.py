# Gunicorn configuration for EbookVoice Backend
# Production-ready settings for multi-worker deployment

import os

# One QueueWorker instance per worker process (set in post_worker_init)
_queue_worker = None

# ==================== Server Socket ====================

# Bind to all interfaces on PORT (Railway provides PORT env var)
bind = f"0.0.0.0:{os.environ.get('PORT', '8080')}"

# Maximum number of pending connections
backlog = 2048


# ==================== Worker Processes ====================

# Number of worker processes.
# Render Starter plan = 512 MB total. Each Python worker baseline ≈ 100-150 MB
# (Flask + Supabase client + edge-tts + cloudinary + asyncio).
# A second worker doubles that base cost and leaves almost nothing for the
# actual conversion (audio buffers + image upload thread + EPUB parsing).
# Stick to 1 worker; throughput comes from the QueueWorker thread pool inside
# it, not from forking more processes.
workers = 1

# Worker class (sync for blocking I/O operations)
# Sync workers are best for TTS generation and Cloudinary uploads
worker_class = "sync"

# Maximum number of simultaneous clients per worker
worker_connections = 1000

# Worker recycling is DISABLED.
#
# Gunicorn's max_requests recycles the worker process after N HTTP requests.
# For a normal web app that's fine, but our worker also runs the conversion
# QueueWorker as a background thread. Recycling the Gunicorn process kills
# that thread mid-conversion — every in-flight chapter fails with "cannot
# schedule new futures after interpreter shutdown" and we lose all progress.
#
# A 10-minute conversion with 3-second status polling produces 200+ requests,
# so even a generous max_requests (1000) gets close. Setting it to 0 disables
# recycling entirely. Render restarts the container on deploy / OOM anyway,
# which gives us a fresh worker often enough that slow leaks aren't a concern.
max_requests = 0
max_requests_jitter = 0

# Worker timeout (5 minutes for long TTS conversions)
timeout = 300

# Keep-alive connections
keepalive = 5


# ==================== Logging ====================

# Access log to stdout (Docker/systemd-friendly)
accesslog = "-"

# Error log to stderr
errorlog = "-"

# Log level (debug, info, warning, error, critical)
loglevel = "info"


# ==================== Process Naming ====================

# Process name shown in `ps` and `top`
proc_name = "ebookvoice_backend"


# ==================== Worker Lifecycle Hooks ====================

def on_starting(server):
    """
    Called just before the master process is initialized.
    """
    print("[Gunicorn] Master process starting")


def when_ready(server):
    """
    Called just after the master process is initialized and ready to spawn workers.
    """
    print(f"[Gunicorn] Server ready. Spawning {server.cfg.workers} workers")
    print(f"[Gunicorn] Listening on {server.cfg.bind}")


def post_worker_init(worker):
    """
    Called just after a worker has been initialized.
    Starts the conversion queue worker for this process.

    Skipped if DISABLE_QUEUE_WORKER is set — useful when running Gunicorn
    locally against the production Supabase project so the laptop doesn't
    claim real users' conversion tasks.  Production (Render) does not set
    this env var.
    """
    global _queue_worker
    print(f"[Gunicorn] Worker {worker.pid} initialized")

    if os.environ.get('DISABLE_QUEUE_WORKER', '').strip().lower() in ('1', 'true', 'yes'):
        print(f"[Gunicorn] DISABLE_QUEUE_WORKER set — worker {worker.pid} won't claim tasks")
        return

    try:
        from auth import get_supabase_client
        from queue_manager import QueueWorker, requeue_stuck_tasks

        supabase = get_supabase_client()

        # Recover any tasks orphaned by the previous server crash.
        # Each worker will call this; only the first will find stuck tasks.
        requeue_stuck_tasks(supabase)

        _queue_worker = QueueWorker(supabase)
        _queue_worker.start()
        print(f"[Gunicorn] Queue worker started for worker {worker.pid}")
    except Exception as e:
        print(f"[Gunicorn] Failed to start queue worker for worker {worker.pid}: {e}")


def worker_exit(server, worker):
    """
    Called just after a worker has been exited.
    Signals the queue worker thread to stop cleanly.
    """
    global _queue_worker
    print(f"[Gunicorn] Worker {worker.pid} exited")
    if _queue_worker:
        _queue_worker.stop()
        _queue_worker = None


def on_exit(server):
    """
    Called just before the master process exits.
    """
    print("[Gunicorn] Master process shutting down")


# ==================== Security ====================

# Limit request line size (protect against malicious requests)
limit_request_line = 4094

# Limit request header field size
limit_request_field_size = 8190

# Limit number of header fields
limit_request_fields = 100


# ==================== Performance Tuning ====================

# Preload app before forking workers (saves memory via copy-on-write)
# Set to False if you experience import issues
preload_app = False

# Enable reloading on code changes (DEVELOPMENT ONLY, set to False in production)
reload = False

# Thread workers (for handling concurrent requests within a worker)
# Keep at 1 for sync workers to avoid threading issues with TTS
threads = 1
