# Known Limitations

Defects and constraints present in the final version of the platform, with root causes and the fix each would take. They are documented rather than fixed because development moved to an on-device architecture.

## Conversion pipeline

### The worker overwrites a task's source text with its results

On completion, `process_chapters_conversion` writes `{'complete': True, 'chapters': converted_chapters}` to the task row. Converted chapters carry `audioUrl`, `duration` and `word_timings` — **not** `content`. So the write destroys the source text.

Harmless when a task finishes and is never touched again. But anything that requeues it afterwards — the stuck sweep, an OOM kill, a crash between this write and the database save — hands the next worker chapters with no text, and `max(1, len(content.split()))` floors every chapter at **one word**. The fingerprint in the data: zero content alongside real MP3 URLs, real durations and complete word timings — output written over input — with chapters reordered by completion time.

A guard already refuses to synthesise when total content is under 50 chars × chapter count, and preserves the failed row. A requeue that fails before the duration-summing step can also leave a playable book with `audiobooks.duration = 0`, which shows 0% progress forever.

**Fix:** write results to a separate column, or merge them into the existing chapters so `content` survives.

### A single chapter has no size cap

The word cap is per *book*. A book that is one giant chapter passes the cap and then kills the container: a 101k-word single-chapter manuscript reached ~99% of synthesis, then the instance restarted — four times in 48 minutes, until the retry cap failed the task.

Synthesis streams per chunk and the concat is ffmpeg, so neither is the problem. The ceiling is the per-chapter tail: ~100k word timings to sanitise, and at edge-tts's 48 kbps CBR (21.6 MB/hour) an ~11-hour chapter is a ~240 MB MP3 — above Cloudinary's 100 MB plain-`upload()` limit, read into a 512 MB container mid-job. The process is killed, not raised, so nothing is logged.

| Chapter size | Audio | MP3 | Outcome |
|---|---|---|---|
| ~20k words | 2.2 h | ~47 MB | completes in ~18 min |
| ~42k words | 4.6 h | ~100 MB | Cloudinary plain-upload limit |
| 101k words | ~11 h | ~240 MB | instance restarts |

**Fix:** split any chapter over ~20,000 words at paragraph boundaries in the extractors (`/extract-chapters`, `/extract-gutenberg`, DOCX, DAISY), titled `"<title> (part N)"`. Everything downstream already works per chapter.

### `source_hash` is never persisted, so there is no duplicate-conversion guard

The client computes a SHA-256 `source_hash` and `/convert-chapters` receives it, but `conversion_tasks` has no `source_hash` column, and `task_manager._OPTIONAL_COLUMNS` — a defensive strip that keeps inserts working on pre-migration schemas — silently drops it. Every audiobook's `source_hash` is NULL. `is_retry` is hard-coded `False`.

Consequence: the same book can be queued twice back to back. In one observed case a user left the Conversion screen after nine seconds, couldn't find their conversion (see below), and started it again; the second task neither completed nor failed.

**Fix:** `ALTER TABLE conversion_tasks ADD COLUMN IF NOT EXISTS source_hash TEXT;`, verify it survives `create_task`, then reject a convert request when an unfinished task exists for the same hash on that account — returning the in-flight task so the app shows its progress.

> A defensive "drop unknown columns" strip makes schema drift silent. It's worth logging what it strips.

## Client

### The Library shows only one in-flight conversion

`LibraryScreen` destructures `activeConversions` (plural) and never uses it; the progress banner reads only `activeConversion`. `ConversionContext` tracks multiple conversions correctly. A second conversion is invisible, which is what drives the duplicate-conversion pattern above. **Fix:** render one banner per entry. A lint pass (`no-unused-vars`) would have caught it — `mobile-app` has no ESLint configuration.

### A failed voice load is a dead end

In `SmartSetupScreen.tsx`, the voice fetch swallows its error (`.catch(() => {})`). `selectedVoice` is assigned only on success and Convert is `disabled={!selectedVoice}`, so a failed or empty load leaves a permanently greyed-out "Select a voice" button with no error, no retry, and no way forward but Back. **Fix:** surface the error with a retry, and fall back to a default voice for the detected language.

### A database outage signs users out

`AuthContext.tsx` treats a transport failure during session restore (DNS, timeout, project restricted) the same as "no session": the user drops to the welcome screen and is offered the anonymous trial, as if they had never had an account. In an outage, that state makes subscription management reachable from what looks like a fresh install. It's the client-side twin of the [anonymous-gate incident](incidents/anonymous-gate-fails-closed.md).

A related gap: analytics identification only fires inside a valid session, so users signed out by an outage can't be identified afterwards.

**Fix:** distinguish "auth unreachable" from "not signed in" and keep the cached session on network failure; never offer the anonymous trial on a device with a stored account; cache the last known identity locally.

## Platform & operations

- **Shared demo book progress.** The sample book is a single `audiobooks` row (`is_demo = TRUE`) served into every library. Non-owner progress writes are acknowledged without writing, but if the owning account plays it, its position is written to the shared row. Fix: no-op progress writes on `is_demo` rows for every identity.
- **Residual karaoke imprecision.** When WordBoundary events are missing, `_generate_synthetic_timings` spreads words evenly across the audio. Karaoke works but is less precise; MultilingualNeural voices emit WordBoundary most reliably.
- **Existing books can't have timings regenerated** — the source text isn't stored after conversion.
- **The API serves one request at a time** (`workers=1`, sync, one thread). See [server architecture](operations/server-architecture.md).
- **edge-tts is an unofficial endpoint.** It impersonates a browser build and is rate-limited; Microsoft can break it without notice. See [the TTS outage](incidents/tts-outage-cascade.md).
- **Android** was never released; see [platforms](platforms.md#android) for the blockers.
- **Unused backend modules.** `emotional_director.py` and `voice_suggester.py` back features the client no longer calls.
