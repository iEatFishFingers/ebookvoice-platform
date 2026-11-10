# Deployment & Operations

## Deployment targets

| Component | Target | Trigger |
|---|---|---|
| Flask API + queue worker | **Render** (Docker, `Dockerfile` + `gunicorn.conf.py`) | push to `main` |
| Web build of the Expo app | **Vercel** (`mobile-app/vercel.json`, `expo export -p web`) | push to `main` |
| iOS / Android binaries | **EAS Build** → App Store Connect / Play Console | manual |
| JS-only mobile fixes | **EAS Update** (OTA) | manual |
| Database | **Supabase** Postgres + Auth | SQL migrations, applied manually |
| Audio, covers, karaoke timings | **Cloudinary** | written by the worker |

## OTA updates (Expo Updates)

JS-only changes ship without an App Store submission.

- `expo-updates` is configured in `app.json` (`updates.url = https://u.expo.dev/<EAS project id>`).
- **`runtimeVersion` is a hard-coded literal, not `{policy: "appVersion"}`.** When `version` is bumped, `runtimeVersion` must be bumped in the same edit — otherwise the new binary advertises the old runtime and OTA bundles cross between builds they weren't built for.
- **Build numbers are managed remotely.** `eas.json` sets `cli.appVersionSource: "remote"` and the `production` profile uses `autoIncrement: true`, so `ios.buildNumber` is intentionally absent from `app.json`.
- **JS-only fix:** `cd mobile-app && eas update --branch production --message "…"` — on devices within ~2 minutes.
- **Native change** (plugins, native modules, permissions, version bumps, expo-updates config): `eas build --platform ios --profile production`.

## Database migrations

SQL lives in `supabase/migrations/` and is applied in order — see [`supabase/migrations/README.md`](../../supabase/migrations/README.md) for verification queries. `000_baseline.sql` creates the core schema; `001`–`016` are the incremental changes made while the app was live.

| Migration | What |
|---|---|
| `001`–`003` | The original monthly conversion gate (later retired — see [paywall & credits](../subsystems/paywall-and-credits.md)) |
| `011_device_push_tokens` | Push tokens for anonymous devices, so the "Audiobook ready" push reaches trial users |
| `012_lifetime_conversion_gate` | The credit-based gate |
| `013_gutenberg_catalog` | The self-hosted public-domain catalog — see [Discover](../subsystems/discover-catalog.md) |
| `014_demo_audiobook` | A shared sample book every new user can play |
| `015_bookshare_tokens` | Schema for a BookShare integration that was never enabled |
| `016_chapter_word_timings_url` | Karaoke timings moved to the CDN — see [word-timings storage](../subsystems/word-timings-storage.md) |

**Schema changes are always additive** — nullable columns, `IF NOT EXISTS`, backwards-compatible response shapes — because binaries already installed on phones keep calling the API long after a release.

## Deploys vs. in-flight conversions

A push to `main` redeploys Render, which restarts the container and kills the chapter in flight (chapter rows are written at the end, so the user loses the elapsed time). Two guards exist:

- **`GET /api/queue-status`** → `{queued, processing, busy}` — counts only, no auth. Returns 503 if the database is unreachable, so "unknown" is never mistaken for "empty".
- A git `pre-push` hook that calls it and refuses a push to `main` while `busy` (and fails closed if the endpoint is unreachable).

Saving a Render environment variable also restarts the container, so the same check applies.

## CDN orphan cleanup

`scripts/cleanup_orphan_cdn_assets.py` walks Cloudinary (`audiobook_covers/`, `epub_images/`, and audio MP3s at the root with `resource_type=video`) and deletes anything not referenced by `audiobooks.cover_url` or `audiobook_chapters.{audio_url, image_inserts[].url}`.

- **Dry run by default.** `--execute` deletes, `--yes` skips the prompt.
- It refuses to run while conversions are queued or processing (in-progress chunks could otherwise be reaped before they are saved).
- It deliberately does **not** scan `raw` resources (karaoke timings) — see [the latent defect it guards against](../incidents/raw-public-id-keeps-its-extension.md).

## Uptime monitoring

> **A health check is only worth what it actually exercises.**

During a multi-week Supabase restriction, `/api/feature-flags` returned HTTP 200 every day because it reads an env var and never touches the database. The endpoints that would actually have caught it:

| Endpoint | During the database outage |
|---|---|
| `/api/feature-flags` | 200 — would have missed it |
| `/api/voices` | 200 — cached, would have missed it |
| `/preview` | 206 — disk-cached audio, would have missed it |
| **`/api/audiobooks`** (with `X-Device-Id`) | **500 — catches it** |
| `/gutenberg/search` | 502 — catches it |
| `/api/queue-status` | 503 — catches it |

Without the `X-Device-Id` header `/api/audiobooks` answers **401**, a healthy-looking response — a monitor that accepts "any response" sails through an outage.

A second, harder lesson came from a TTS outage: *every* HTTP signal stayed green while no conversion could produce audio — see [the TTS outage cascade](../incidents/tts-outage-cascade.md). Only a real chapter converted end to end proves the pipeline.

## Supabase quota behaviour

When a free/Pro quota is breached, Supabase restricts the project and it **does not resume itself** when the quota period resets — it needs a manual restore in the dashboard. That is what turned a quota breach into a multi-week outage; the usage dashboard needs a weekly check, not a monthly one.

## Custom domain checklist

The web build is origin-agnostic, but four external systems are not. Each needs the new origin when a domain changes:

| System | Setting | Symptom when missing |
|---|---|---|
| Render env | `ALLOWED_ORIGINS` — comma-separated, scheme included, no trailing slash (read in `epub_to_audio.py`; no wildcard in production) | Page loads but Discover/library are empty and login fails — every API response blocked by CORS. Native apps unaffected (no `Origin` header). |
| Supabase → Auth → URL Configuration | Redirect URLs include `https://<domain>/**` | Google sign-in and password reset bounce to an error (`redirectTo` is built from `window.location.origin`). |
| Google Cloud OAuth client | Authorized JavaScript origins | Google sign-in on web refused at consent. |
| Render env `APP_URL_WEB` | `https://<domain>/payment` (`stripe_utils.py`) | Stripe returns users to the old origin after checkout. |

## Routine maintenance

| Cadence | Task |
|---|---|
| Weekly | Supabase usage dashboard; Render restart frequency |
| Monthly | Cloudinary usage |
| Quarterly | `cleanup_orphan_cdn_assets.py --execute`; review failed `conversion_tasks` rows |
| Every ~80 days | Fresh TestFlight build to beat the 90-day expiry |

## Related

- [Server architecture](server-architecture.md)
- [App Store & web](app-store-and-web.md)
- [Local setup](../local-setup.md)
