# The TTS outage cascade — six days of empty books with every health signal green

**Severity:** critical · **Duration:** ~6 days of total outage, followed by partial chapter loss · **Status:** resolved

Four defects, each harmless-looking on its own, stacked into the worst failure the platform had: for six days every conversion produced an empty or partial audiobook, the app told users their books were ready, and every conventional health signal — HTTP status, restarts, queue drain, even voice auditions — stayed green.

```
  1. Microsoft rejects the pinned edge-tts token  ──▶  every chapter fails
                    │ (fixed by a version bump)
                    ▼
  2. Microsoft rate-limits a share of requests     ──▶  some chapters fail, no retry
                    │
                    ▼
  3. Failure counts as progress; complete:True     ──▶  user told "ready"
     written with no shortfall check
                    │
  4. A refused audition poisons the preview cache  ──▶  "voice test" looks healthy / plays silence
```

## 1. The attestation token — total outage

`requirements.txt` pinned `edge-tts==7.2.7`. That version mints a `Sec-MS-GEC` attestation token derived from a **hard-coded Chromium version string**, and Microsoft began refusing it. Every failure carried the same version:

```
ERROR: 403, message='Invalid response status', url='wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?...&Sec-MS-GEC-Version=1-143.0.3650.75'
```

Text extraction and chunking were unaffected; only the WebSocket synthesis leg failed.

| Day | 403s | Chapters produced |
|---|--:|--:|
| 1 | 9 | 0 |
| 2 | 27 | 10 |
| 3 | 0 | — (no conversions) |
| 4 | 13 | 0 |
| 5 | 208 | 0 |
| 6 | 429 | 0 |
| **Total** | **686** | **10** |

**A staged rollout, not a clean cutover.** One 37-chapter book with a single voice on day 2 succeeded on chapters 1–4, failed on 5–28, then succeeded and failed interleaved *within the same minute*. That rules out voice, language, chapter position and length, and points to a progressive rollout across Microsoft's edge nodes. From day 4 the failure rate was 100%.

**External cause — proven, not assumed.** Zero gunicorn restarts across the window (the previous comparable period had 14, proving the logs capture them), PID 1 survived throughout, and no commits had been made for a month. A code change or redeploy was ruled out. The previous six days logged **0** mentions of `speech.platform.bing.com` — only failures log that URL — and **456** successful chapter syntheses.

**Fix:** bump to `edge-tts 7.3.1`. Same machine, same IP, within one minute, all three test voices went from 403 to valid audio. Reproducing the 403 from a residential IP ruled out IP reputation or hosting-provider blocking.

> Impersonating a pinned browser build means this recurs whenever Microsoft rotates the scheme. It is the structural weakness of building on an unofficial endpoint.

## 2. Rate limiting — silent partial books

With connections working again, a second failure surfaced: the endpoint **refuses a share of requests**, raising `NoAudioReceived` after ~3 s.

Sequential, single-stream probes with one voice (concurrency excluded):

| Words | Result |
|--:|---|
| 4 / 50 / 200 | OK |
| **500** | refused in 2.9 s |
| **718** | refused in 2.9 s |

The identical refused 500-word text **succeeded** on a later attempt — refusal is probabilistic, with odds that worsen with request size. `CHUNK_MAX_WORDS = 1000` sat deep in the bad band.

**Debugging traps worth recording:**

- **Per-IP allowance depletes with use.** After sustained probing, 285–300-word requests were refused from the same laptop; ~15 minutes of quiet restored 400-word renders. "Works on the server, fails locally" is expected and is *not* evidence of a code difference — probing to test recovery consumes allowance.
- **Microsoft caches identical requests.** The same 500-word text returned byte-identical audio in 2.0 s after taking 146 s the first time. Re-running a benchmark on unchanged text measures a ~70× speedup that doesn't exist; always vary the text.
- **Two earlier diagnoses were wrong** — first concurrency (disproved by a lone single-stream request failing), then a hard size ceiling (disproved by the same text succeeding on retry). Both came from inferring cause from correlation in bulk logs; both took ~2 minutes to disprove in isolation. *Test one request before theorising about many.*

**Fix (`word_timing.py`):**

- **Per-chunk retry** on refused synthesis in `_generate_with_event_retry` — 4 attempts, 5 s doubling backoff, wrapping the existing zero-WordBoundary retry.
- **Retry per chunk, not per chapter.** A 3-chunk chapter needs all three chunks in one pass; at p≈0.5 per chunk, four whole-chapter attempts reach only ~40% success. Independent per-chunk retries don't compound.
- **Concurrent streams 4 → 2** (`chunk_sem` 2 → 1), the level previously measured as net-fastest once throttling is counted; it also halves peak TTS memory on the 512 MB instance.
- `CHUNK_MAX_WORDS`, `SYNTH_MAX_ATTEMPTS` and `SYNTH_BACKOFF_BASE_S` are env-overridable so the chunk size can be tuned in place.

A latent bug surfaced during recovery: `_concat_mp3_files` passed `-f concat` for the input but no output format, and ffmpeg inferred the muxer from the temp file's `.mp3.tmp` suffix and failed. The path had never worked anywhere — masked by a binary-concat fallback used whenever ffmpeg was absent — until ffmpeg was installed for exact chunk durations. Fixed with an explicit output format; ffmpeg's stderr is now logged from the **tail** (the head is the version banner).

## 3. False success — why users were told their books were ready

```python
# a failed chapter is swallowed
except Exception as e:
    print(f"  [{chapter_num}/{total_chapters}] ERROR: {e}")
    return idx, None, time.time() - chapter_start

# ...and still counts as progress
completed_count[0] += 1          # unconditional
```

So 77 refused chapters still printed `📊 Progress: 77/77 complete`, and the ETA *shrank* as chapters failed in 3 s each. Then:

- **When every chapter failed**, `complete: True` was written ~476 ms *before* the save raised and wrote `error`. `update_task` is a partial column update, so the row ended `complete=True` **and** `error` set — but the client stops polling the moment it sees `complete`. Final-poll byte sizes proved it: polls landing after the error were 540–577 bytes; the one that landed in the window was 494, error absent. Against a 3 s poll interval, a ~0.5 s window is ~1 in 6.
- **When some chapters survived**, the save succeeded, nothing raised, no error was ever set — a 77-chapter novel containing 25 chapters, labelled ready, with no error recorded anywhere.
- The closing log banner read `✔ CONVERSION COMPLETE` even directly after `❌ All 0 chapter inserts failed` — 18 STARTED, 17 COMPLETE, **0** FAILED across two weeks. Anyone grepping logs for health was told the opposite of the truth.

**Fix (`process_chapters_conversion`):**

- Compare `len(converted_chapters)` against the number of chapters **actually attempted** — counting only chapters with non-blank content, because `_do_chapter` legitimately returns `None` for blank section dividers. A plain non-empty check would not have caught 25-of-77; `len(chapters)` would have flagged healthy books as partial.
- On a shortfall, set `error` with plain-language copy naming the numbers ("Only 25 of 77 chapters could be converted…"). The status reads "Converted 25 of 77 chapters" and the push notification says "Conversion incomplete" instead of celebrating.
- `error` is the signal on purpose: the client already checks `error` **before** the success path, so binaries already installed handle it correctly with no app update.
- Chapters that did convert are kept. `scripts/repair_partial_audiobook.py` fills in missing chapters of a partial book in place.

## 4. Poisoned preview cache — why voice auditions looked healthy

`/preview` caches each voice's sample under `tempfile.gettempdir()`, keyed by voice id, and treated any existing file as a hit. But `communicate.save()` **opens the output file before streaming**, so a refused synthesis left an **empty file** behind. From then on, every request for that voice returned `200 audio/mpeg` with zero bytes for the life of the container. A redeploy cleared it (ephemeral `/tmp`), which is why it was easy to miss. Disk-cached previews also meant that during the token outage a manual voice test *passed*.

**Fix:** `create_preview_async` raises if the saved file is missing or empty and deletes partial output; the route treats `not exists or getsize == 0` as a miss (so existing poison heals on the next request), and an explicit guard returns 503 rather than ever sending an empty body.

## Lessons

1. **A green health check is not proof the product works.** HTTP 200, zero restarts and a draining queue were all true for six days. Only a real chapter converted end to end proves the pipeline.
2. **Never let failure count as progress.** Progress counters, completion flags and log banners must distinguish success from failure — and completion must be verified by **count against input**, not by a flag.
3. **Write the error before (or instead of) the success flag** when a client stops listening on success.
4. **A dependency that impersonates a browser will break on someone else's schedule.** Pinning it guarantees the break; tracking it loosely only shortens the outage.
5. **Single-chapter tests can't surface rate limits.** The token fix looked conclusive on one chapter and wasn't.

## Related

- [Server architecture](../operations/server-architecture.md) · [Deployment — uptime monitoring](../operations/deployment.md#uptime-monitoring)
- [Karaoke timings](../subsystems/karaoke-timings.md)
