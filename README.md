# EbookVoice Platform

**Turn any ebook into a narrated audiobook with word-by-word follow-along.**
A full-stack, production-proven system: a cross-platform React Native app, a Flask conversion service with a Postgres-backed job queue, neural text-to-speech, CDN media storage, and dual payment processors — built to serve blind and print-disabled readers first.

> **Status: complete.** This repository is the final, self-contained version of the server-based EbookVoice platform as it ran in production (App Store release 1.1.0). It is published as a reference implementation and can be run end to end on one machine — see [local setup](docs/local-setup.md).

---

## What it does

- **Converts ebooks to audio** — EPUB, Word `.docx` and DAISY (the accessible-book standard), or any of ~75,000 public-domain titles from a built-in Project Gutenberg catalogue
- **214 neural voices across 27 languages**, with automatic language detection and native-language voice previews
- **Karaoke follow-along** — word-level highlighting kept in sync through chunk merges, seeks and speed changes
- **Listening that respects the commute** — background and lock-screen playback, CarPlay, Bluetooth controls, 0.5×–3× speed, offline downloads, resume across devices
- **Accessibility first** — VoiceOver-correct controls throughout, built with and for screen-reader users
- **Anonymous trial → account → subscription**, with an accruing credit model and in-app purchase on iOS / Stripe on web

## Architecture

```
  Expo / React Native app ──────────────▶ Flask API (gunicorn, Docker on Render)
  iOS · Android · Web                      │  security/ parsers & validators
  one codebase, services/api.ts            │  QueueWorker thread ──▶ edge-tts (neural TTS)
         ▲                                 │        │
         │ audio · timings                 ▼        ▼
  Cloudinary CDN ◀───────────────────── Supabase Postgres + Auth
                                         conversion_tasks = the job queue
  RevenueCat (IAP) · Stripe (web) ──webhooks──▶ profiles.subscription_tier
```

- **Postgres as the job queue** — workers claim tasks with `FOR UPDATE SKIP LOCKED`; heartbeats, a stuck-task sweep, a retry cap and a wedge watchdog give crash recovery without a separate broker.
- **Tuned to a 512 MB instance** — bounded TTS stream concurrency, payload stripping on hot routes, batched inserts, gzip, background image uploads.
- **Backwards-compatible by construction** — installed app binaries keep calling the API for months, so every schema and response change is additive (e.g. one endpoint serves inline karaoke timings to old clients and CDN URLs to new ones).
- **One client, three platforms** — ~90% shared code; platform divergence isolated behind interfaces (three audio players, two payment processors, three sign-in flows).

Full write-up: **[docs/architecture.md](docs/architecture.md)**

## Tech stack

| Layer | Technology |
|---|---|
| App | React Native 0.81, Expo SDK 54, TypeScript, React Navigation, react-native-track-player, expo-av, EAS Build & Update |
| API | Python 3.11, Flask, gunicorn, Flask-Compress, Docker |
| Speech | edge-tts (Microsoft neural voices), ffmpeg / pydub |
| Data & auth | Supabase — Postgres, PostgREST, Auth (email, Google, Apple), SQL RPCs |
| Media | Cloudinary (audio, images, timing JSON) — or local disk via `local_storage.py` |
| Payments | RevenueCat → Apple IAP / Google Play Billing; Stripe Checkout & Billing Portal |
| Hosting | Render (API), Vercel (web), App Store Connect |
| Analytics | PostHog |

## Run it locally

```bash
npx supabase start                  # Postgres + Auth, applies all migrations
cp .env.example .env                # paste the keys it prints
docker compose up --build           # API + queue worker on :8080
cd mobile-app && cp .env.example .env && npm install && npm run web   # app on :8081
```

No Cloudinary, Stripe or RevenueCat account required. Details and troubleshooting: **[docs/local-setup.md](docs/local-setup.md)**

## Documentation

| | |
|---|---|
| [Architecture](docs/architecture.md) | System overview, conversion lifecycle, data model, API surface |
| [Local setup](docs/local-setup.md) | Run the full stack on one machine |
| **Subsystems** | [Karaoke timings](docs/subsystems/karaoke-timings.md) · [Word-timings storage](docs/subsystems/word-timings-storage.md) · [Audio playback](docs/subsystems/audio-playback.md) · [Multi-language](docs/subsystems/multilanguage.md) · [Discover catalogue](docs/subsystems/discover-catalog.md) · [Paywall, credits & payments](docs/subsystems/paywall-and-credits.md) |
| **Operations** | [Server architecture & tuning](docs/operations/server-architecture.md) · [Deployment & monitoring](docs/operations/deployment.md) · [App Store review](docs/operations/app-store-and-web.md) |
| [Platforms](docs/platforms.md) | iOS, Android and web — what's shared and where they diverge |
| [Incidents](docs/incidents/README.md) | Production post-mortems: what broke, how it was found, what changed |
| [Known limitations](docs/known-limitations.md) | Remaining defects with root causes and fixes |
| [Release history](docs/release-history.md) | iOS builds and what each shipped |

### Featured post-mortem

**[Six days of empty audiobooks with every health check green](docs/incidents/tts-outage-cascade.md)** — a pinned TTS client rejected upstream, rate-limiting exposed by the fix, a completion flag written before the error, and a poisoned preview cache that made manual tests pass. Four small defects, one cascade, and the changes that make each impossible to repeat silently.

## Repository layout

```
epub_to_audio.py       Flask app: routes, conversion handlers, payments, gates
queue_manager.py       Postgres-backed job queue worker
task_manager.py        conversion_tasks access layer
word_timing.py         chunked TTS synthesis, retries, timing sanitisation
local_storage.py       local-disk stand-in for Cloudinary
security/              file parsers, validators, auth decorators, rate limiting
tier_limits.py         credit allowance and word-cap rules
voice_manager.py       voice catalogue (voice_cache.json)
scripts/               ops tools: catalogue ingest, CDN cleanup, timing backfill, repair
supabase/migrations/   schema, applied in order
tests/                 backend tests
mobile-app/            Expo app (iOS, Android, web)
docs/                  architecture, subsystems, operations, incidents
```

## License

Published for reference and evaluation. See the repository settings for license terms.
