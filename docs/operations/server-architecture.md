# Server Architecture & Capacity Tuning

The backend ran on a single **Render Starter instance (512 MB RAM)** on a paid plan, so instances stayed warm — cold starts were never a factor. Everything below is tuned to fit that 512 MB budget; raising any concurrency setting without more RAM multiplies the memory ceiling and OOMs the container.

## Concurrency limits — matched to RAM

| File | Setting | Value |
|---|---|--:|
| `gunicorn.conf.py` | `workers` | 1 |
| `gunicorn.conf.py` | `max_requests` | 0 (recycling **disabled**) |
| `queue_manager.py` | `GLOBAL_CONCURRENCY_LIMIT` | 1 |
| `queue_manager.py` | `MAX_TASKS_PER_WORKER` | 1 |
| `epub_to_audio.py` | `PARALLEL_CHAPTER_WORKERS` | 2 per conversion |
| `word_timing.py` | `asyncio.Semaphore(...)` | 2 concurrent chunks per chapter |

**Net effect:** at most **4 concurrent edge-tts WebSocket streams** system-wide (1 conversion × 2 chapter workers × 2 chunks each). Each costs ~7–10 MB resident, so TTS peaks around 40 MB.

## Why `max_requests = 0`

Gunicorn's `max_requests` recycles the worker after N HTTP requests. **The background QueueWorker thread cannot survive process recycling** — recycling mid-conversion kills every in-flight chapter with *"cannot schedule new futures after interpreter shutdown"*.

A 10-minute conversion at 3 s client polling is 200+ requests, so even a generous threshold gets close. Recycling is off; the container restarts on deploy or OOM, which refreshes the worker often enough.

## Queue worker hardening

- **Heartbeat + stuck sweep.** `STUCK_THRESHOLD_MINUTES = 2` with a **30 s heartbeat**: each chapter's `_do_chapter` runs a daemon thread bumping `started_at = now()` and the word-rate ETA every 30 s. Without it, long chapters (3–5 min on a 7k-word section) look stuck to the requeue sweep, get flipped back to `queued`, and the client shows "in queue" while the worker is still synthesising.
- **Wedge watchdog.** The heartbeat self-terminates after `CHAPTER_HEARTBEAT_MAX_S = 30 min` on a single chapter — that long means the edge-tts stream is wedged (one production task once heartbeated for 8+ hours on a hung chapter, so the sweep never fired). Once the heartbeat stops, `started_at` goes stale and the sweep requeues; a retry cap prevents infinite loops.
- **503, not 404, when the DB is unreachable.** `/status` and the ownership decorator call `task_manager.get_task(..., distinguish_errors=True)`, which returns a `TaskManager.DB_ERROR` sentinel on database failure. The client drops a task after 3 consecutive 404s, so misreporting a Supabase outage as 404 used to kill healthy in-flight conversions.
- **`REQUEUE_SWEEP_INTERVAL_S = 60`** — an OOM-killed task self-heals within ~3 minutes instead of waiting for a restart.
- **`cleanup_old_tasks` only deletes `queue_status in ('done','cancelled')`.** Failed tasks are preserved indefinitely so CDN orphans can be reaped manually and silent failures stay inspectable.

## Memory hygiene

- **`/status/<task_id>` and `/api/conversions/active`** strip the `chapters` payload while in progress (700 KB+ on long books). The full row is returned only on `complete=true`.
- **`/api/audiobooks`** (library list) returns metadata only — no word timings, no image inserts. The Player fetches `/api/audiobooks/<id>` on entry and loads karaoke data in the background.
- **Gzip on all JSON** via `flask-compress` (5–10×; a 6 MB library list becomes ~600 KB on the wire).
- **Background image upload** (`_bg_upload_images`) runs in a daemon thread with `max_workers=4`, frees image bytes after each upload, and caps at 30 images per book.
- **Batched chapter INSERT** in `process_chapters_conversion` writes chunks of **3** chapters. A monolithic 30-chapter INSERT with multi-MB timing blobs hit Supabase's statement timeout (`57014`); see [the incident](../incidents/karaoke-timings-statement-timeout.md) and [word-timings storage](../subsystems/word-timings-storage.md).

## Known log noise

`queue_manager.py` logs `RPC error: ConnectionTerminated … last_stream_id:19999` roughly every 5½ hours — the HTTP/2 client hitting its stream ceiling and Supabase sending GOAWAY. The handler releases the slot and reconnects on the next poll, so the cost is one skipped 2-second poll.

## Scaling path

The real throughput ceiling was never RAM but **`workers = 1`, `worker_class = "sync"`, `threads = 1`** — the API served one HTTP request at a time. Moving to a 2 GB instance would allow `GLOBAL_CONCURRENCY_LIMIT` / `MAX_TASKS_PER_WORKER` of 2–3 and `PARALLEL_CHAPTER_WORKERS` of 3. Measured production load (zero restarts, zero OOM kills, zero stuck requeues over sustained windows) never required it.

## Related

- [Local setup](../local-setup.md) — running the backend without a shared production queue
- [Deployment & operations](deployment.md)
- [Audio playback](../subsystems/audio-playback.md) — the progress-write cadence that interacts with the single-request ceiling
