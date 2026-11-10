# Architecture

EbookVoice turns ebooks a reader already owns (EPUB, Word `.docx`, DAISY) — or public-domain books from a built-in catalogue — into narrated audiobooks with word-by-word follow-along highlighting. This is the server-backed architecture it ran on in production.

## System overview

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │  Expo / React Native app  (mobile-app/)                              │
 │  iOS · Android · Web — one codebase                                  │
 │                                                                      │
 │  screens ─▶ contexts (Auth, Conversion, Download, Theme…)            │
 │                 │                                                    │
 │           services/api.ts  ── single HTTP client: auth headers,      │
 │                 │              device identity, retries, 404-vs-503  │
 └─────────────────┼────────────────────────────────────────────────────┘
        HTTPS/JSON │                 ▲ audio · covers · karaoke JSON
                   ▼                 │ (fetched straight from the CDN)
 ┌──────────────────────────────┐    │
 │  Flask API  (Render, Docker) │    │
 │  epub_to_audio.py + security/│    │
 │                              │    │      ┌───────────────────────┐
 │  ┌────────────────────────┐  │    └──────│  Cloudinary           │
 │  │ gunicorn worker        │  │  upload   │  MP3s · cover images  │
 │  │  • HTTP routes         │──┼──────────▶│  word-timing JSON     │
 │  │  • QueueWorker thread  │  │           └───────────────────────┘
 │  └──────────┬─────────────┘  │
 │             │ edge-tts (WSS) │           ┌───────────────────────┐
 │             └────────────────┼──────────▶│  Microsoft Edge       │
 └─────────────┬────────────────┘           │  neural TTS endpoint  │
               │ PostgREST / RPC            └───────────────────────┘
               ▼
 ┌──────────────────────────────┐           ┌───────────────────────┐
 │  Supabase                    │           │  RevenueCat ◀── IAP   │
 │  Postgres · Auth (JWT)       │◀──────────│  Stripe     ◀── web   │
 │  conversion_tasks = queue    │  webhooks └───────────────────────┘
 └──────────────────────────────┘
```

| Component | Responsibility |
|---|---|
| **Expo app** (`mobile-app/`) | UI, playback (RNTP / expo-av / HTMLAudio), karaoke rendering, downloads, purchases. All server calls go through `services/api.ts`. |
| **Flask API** (`epub_to_audio.py`) | Upload parsing, conversion gate, enqueue, status, library, progress, payments webhooks. |
| **`security/`** | Hardened EPUB / DOCX / DAISY parsers, input validators, auth decorators (`require_auth`, `optional_auth`, `require_task_ownership`), rate limiting, security headers, audit log. |
| **QueueWorker** (`queue_manager.py`) | Background thread inside the gunicorn worker that claims queued conversions from Postgres and runs them. |
| **TTS pipeline** (`word_timing.py`) | Chunked edge-tts synthesis with WordBoundary capture, retry, MP3 concat and timing sanitisation. |
| **Supabase** | Postgres (profiles, audiobooks, chapters, tasks, catalogue), Auth (email, Google, Apple), atomic RPCs. |
| **Cloudinary** | Audio, cover images and karaoke timing files. `local_storage.py` substitutes local disk when it isn't configured. |
| **RevenueCat / Stripe** | Mobile in-app purchase and web checkout respectively; both land the tier on `profiles.subscription_tier`. |

## A conversion, end to end

```
 app                         API                          Postgres            Worker thread
  │ POST /extract-chapters    │                              │                    │
  │──────────────────────────▶│ parse (security/), detect    │                    │
  │◀── chapters, language ────│ language, images → bg thread │                    │
  │                           │                              │                    │
  │ POST /convert-chapters    │                              │                    │
  │──────────────────────────▶│ gate: credits, word cap      │                    │
  │                           │── INSERT conversion_tasks ──▶│ queued             │
  │◀── 202 {task_id} ─────────│                              │                    │
  │                           │                              │◀─ claim_next_      │
  │                           │                              │   queued_task()    │
  │                           │                              │   FOR UPDATE       │
  │                           │                              │   SKIP LOCKED ────▶│ processing
  │ GET /status/<id> (3 s)    │                              │                    │ per chapter:
  │──────────────────────────▶│── read task (chapters ──────▶│◀── heartbeat 30 s ─│  chunk → edge-tts
  │◀── progress, ETA ─────────│   payload stripped)          │                    │  retry refused chunks
  │                           │                              │                    │  concat MP3, sanitise
  │                           │                              │                    │  timings → Cloudinary
  │                           │                              │◀── audiobook +  ───│ verify count vs input
  │                           │                              │    chapters (×3)   │ increment credit (RPC)
  │◀── complete / error ──────│                              │                    │ push notification
```

Key properties:

- **Postgres is the queue.** `claim_next_queued_task` uses `FOR UPDATE SKIP LOCKED` with global and per-user limits checked inside the transaction, so any number of workers can compete without double-claiming.
- **Crash recovery.** A 30 s heartbeat keeps `started_at` fresh; a sweep every 60 s requeues tasks stale for 2 minutes, with a retry cap (`MAX_TASK_RETRIES`) so a poison task fails instead of crash-looping. A watchdog stops the heartbeat after 30 minutes on one chapter, so a wedged TTS stream becomes requeueable.
- **Completion is verified by count.** The worker compares converted chapters against chapters attempted (excluding blank section dividers) and sets `error` on any shortfall — see [the TTS outage](incidents/tts-outage-cascade.md).
- **Additive schema, two client generations.** Binaries already on phones keep calling the API, so every schema and response change is additive. Example: the detail route hydrates karaoke timings inline for old clients and returns CDN URLs to new ones (`?timings=url`).
- **Identity is `user_id XOR device_id`.** Anonymous users get a full trial keyed by a device id; `POST /api/anonymous/claim` moves their books to an account on signup.

## Data model (core tables)

| Table | Purpose |
|---|---|
| `profiles` | One row per account: `subscription_tier`, `conversion_count`, Stripe customer id, terms acceptance, push token |
| `audiobooks` | Book metadata, `user_id` **or** `device_id`, `duration`, progress, `language`, `cover_url`, `is_demo` |
| `audiobook_chapters` | Per-chapter `audio_url`, `duration`, `position`, `word_timings_url` (legacy `word_timings`), image inserts |
| `conversion_tasks` | The queue: `queue_status`, `chapters` payload, progress/ETA, `retry_count`, `error`, `complete` |
| `gutenberg_books` | Self-hosted Project Gutenberg catalogue (~75k rows) |
| `device_push_tokens` | Push tokens for anonymous devices |
| `processed_webhooks` | Idempotency for payment webhooks |
| `playback_events` | Listening heatmap / analytics |
| `security_audit_log` | Security-relevant events |

RPCs: `claim_next_queued_task`, `requeue_stuck_tasks`, `increment_conversion_count`. Schema: `supabase/migrations/`.

## API surface

| Area | Routes |
|---|---|
| Ingest | `POST /extract-chapters` · `POST /extract-gutenberg` · `GET /gutenberg/search` |
| Convert | `POST /convert-chapters` · `GET /status/<task_id>` · `GET /api/conversions/active` · `POST /api/conversions/<id>/cancel` · `GET /api/queue-status` |
| Voices | `GET /api/voices?lang=` · `GET /preview?voice=` |
| Library | `GET /api/audiobooks` · `GET/DELETE /api/audiobooks/<id>` · `PUT …/progress` · `PUT …/metadata` · `POST /api/cover-upload` |
| Account | `GET/PUT /api/profile` · `POST /api/profile/accept-terms` · `POST /api/anonymous/claim` · `DELETE /api/account` · `POST/DELETE /api/push-token` |
| Payments | `POST /api/create-checkout-session` · `POST /api/create-portal-session` · `POST /api/webhook` (Stripe) · `POST /api/sync-mobile-purchase` · `POST /api/revenuecat-webhook` |
| Ops | `GET /api/feature-flags` · `/analytics/*` |

Legacy single-file routes (`/convert`, `/convert-text`) and endpoints for retired features (`/suggest-voices`, `/analyze-*`) remain for old binaries.

## Design decisions worth reading

- [Server architecture](operations/server-architecture.md) — how the pipeline fits in 512 MB, and why worker recycling is off
- [Word-timings storage](subsystems/word-timings-storage.md) — moving 104 MB of blobs out of Postgres without breaking old clients
- [Paywall, credits & payments](subsystems/paywall-and-credits.md) — accruing credits, and why two payment processors exist
- [Karaoke timings](subsystems/karaoke-timings.md) — keeping highlighting in sync across chunk boundaries and seeks
- [Incidents](incidents/README.md) — what broke in production and what changed because of it
