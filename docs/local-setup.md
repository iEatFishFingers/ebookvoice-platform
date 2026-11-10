# Running EbookVoice locally

The whole stack runs on one machine: a local Supabase (Postgres + Auth) via the Supabase CLI, the Flask API + queue worker, and the Expo app in a browser or simulator. **No Cloudinary, Stripe or RevenueCat account is needed** — media is stored on local disk and payment features are simply unavailable without keys.

The one external dependency is Microsoft's Edge TTS endpoint, reached over the internet by `edge-tts` — conversions need a network connection.

## Prerequisites

- **Docker** (Docker Desktop on macOS/Windows) — the Supabase CLI runs Postgres and Auth in containers
- **Node.js 18+** and npm
- **Python 3.11** (matches the production `Dockerfile`), or use `docker compose` for the API
- Optional: **ffmpeg** on `PATH` — exact chunk durations for multi-chunk chapters (a byte-level fallback is used without it)

## 1. Database — local Supabase

```bash
npx supabase start
```

The first run pulls the images, then applies every migration in `supabase/migrations/` in order (`000_baseline.sql` creates the core schema; `001`–`016` are the changes made while the app was live). When it finishes it prints the local credentials:

```
API URL: http://127.0.0.1:54321
anon key: eyJ...
service_role key: eyJ...
JWT secret: super-secret-...
Studio URL: http://127.0.0.1:54323
```

Re-apply from scratch at any time with `npx supabase db reset`. Studio (the database UI) is at http://127.0.0.1:54323; auth emails (password resets) are captured by the local mail server at http://127.0.0.1:54324.

## 2. Backend — Flask API + queue worker

```bash
cp .env.example .env
# set SUPABASE_SERVICE_KEY and SUPABASE_JWT_SECRET from the output above
```

**Option A — Docker (same image and gunicorn config as production):**

```bash
docker compose up --build
```

**Option B — Python directly:**

```bash
python -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate
pip install -r requirements.txt
python epub_to_audio.py           # dev server on http://localhost:8080
# or, as production ran it:
gunicorn -c gunicorn.conf.py wsgi:app
```

On startup you should see `[storage] CLOUDINARY_CLOUD_NAME not set — using local disk…`. Media is written to `./local_media` and served at `http://localhost:8080/media/…`.

Check it:

```bash
curl http://localhost:8080/api/queue-status     # {"queued":0,"processing":0,"busy":false}
curl "http://localhost:8080/api/voices?lang=en" # the voice catalogue
```

### Populate the Discover catalogue (optional)

```bash
python scripts/ingest_gutenberg_catalog.py
```

Downloads Project Gutenberg's `pg_catalog.csv` (~75k books) into `gutenberg_books`. Without it, Discover search returns nothing, but uploading your own EPUB still works.

## 3. App — Expo

```bash
cd mobile-app
cp .env.example .env
# set EXPO_PUBLIC_SUPABASE_ANON_KEY from the `supabase start` output
npm install
npm run web          # http://localhost:8081
```

For the iOS simulator use `npm run ios` (requires Xcode and a dev build — RNTP and IAP are native modules). For a physical device, set `EXPO_PUBLIC_DEV_API_URL` in `mobile-app/.env` **and** `PUBLIC_BASE_URL` in the backend `.env` to your machine's LAN IP, so the phone can reach both the API and the locally stored audio.

## 4. Try it

1. Open http://localhost:8081 and continue without an account (anonymous trial) or sign up — local sign-ups don't need email confirmation.
2. Upload `docs/sample_book.epub` (or any EPUB / `.docx` / DAISY zip), or pick a book from Discover.
3. Choose a language and voice, press **Convert**, and watch the queue worker in the backend logs:
   ```
   [1/9] START Chapter 1 …
   [1/9] Done in 41.2s
   📊 Progress: 1/9 complete | ~4m 21s remaining
   ```
4. Open the book in the Library: playback, speed control and karaoke follow-along work from local media.

## Running the tests

```bash
python -m pytest tests            # backend (run under Python 3.11)
cd mobile-app && npx tsc --noEmit # app type-check
```

## What's not available locally

| Feature | Needs |
|---|---|
| CDN media storage | `CLOUDINARY_*` |
| Web subscriptions | `STRIPE_*` (+ Stripe CLI to forward webhooks to `/api/webhook`) |
| Mobile in-app purchases | `REVENUECAT_*`, App Store / Play products, a native build |
| Push notifications | A physical device and an EAS project |
| Google / Apple sign-in | OAuth providers configured in `supabase/config.toml` |
| Lock-screen / CarPlay playback | A native iOS build (`FEATURE_RNTP_ENABLED=true`) |

Without those keys the corresponding screens show an error or don't appear; everything else — upload, conversion, library, playback, karaoke, the credit gate — works.

## Troubleshooting

- **Discover is empty / every request fails in the browser** — `ALLOWED_ORIGINS` must include the app's origin (`http://localhost:8081`).
- **Audio won't play on a phone** — `PUBLIC_BASE_URL` still says `localhost`; use your LAN IP.
- **Chapters fail with `NoAudioReceived` or 403** — the TTS endpoint is refusing requests. Refusals are retried per chunk; persistent 403s mean the `edge-tts` version needs bumping. See [the TTS outage](incidents/tts-outage-cascade.md).
- **Sharing a database with another running backend** — set `DISABLE_QUEUE_WORKER=true` on one of them, or both will claim the same queue.
