# Karaoke (follow-along word highlighting)

Word-by-word highlighting synchronised with the narration. For blind and print-disabled readers — the app's core audience — off-beat highlighting is a product defect, not a polish issue.

Three stacked causes of cumulative drift were fixed in a redesign, with the deepest cause found later. The patterns below are the result.

## Backend timing pipeline (`word_timing.py`)

Every synthesised timing array goes through **`sanitize_word_timings()`** before it is stored. It:

1. drops empty / punctuation-only entries
2. sorts by start time and drops zero-duration entries (defending against rare non-monotonic edge-tts events)
3. sets each word's `end` to the next word's `start`, so trailing TTS pauses (~500 ms after a sentence) are absorbed into the just-finished word's active window

The binary search in `KaraokeReader` assumes a **sorted, gap-free, non-overlapping** array — nothing may bypass the sanitiser.

**Multi-chunk merges.** Chapters over ~1,000 words are synthesised in chunks. The time offset between chunks comes from the actual chunk MP3 duration via `ffprobe`, falling back to last-word-end + 0.5 s when ffprobe is unavailable. Using `chunk_timings[-1]['end']` as the offset underestimates by the trailing silence and accumulates drift across chunks.

## Frontend interpolation (`PlayerScreen.tsx`)

The player polls position every ~250 ms and interpolates between polls. Every site that changes the audio position imperatively — slider, rewind 15 s, forward 15 s, chapter auto-advance, manual chapter selection — goes through **`snapKaraokeTo(seconds)`**, which re-anchors `positionStateRef` and bumps `seekToken`. A position change that skips it makes karaoke lag or jump for the polling window.

- `handleSpeedChange` updates `positionStateRef.rate` immediately (with a re-anchored time and wall clock) so `getPosition()` doesn't extrapolate at the old rate during the status-callback gap.
- An `AppState` listener zeroes `wallClock` when the app goes to the background. Without it, `getPosition()` extrapolates against a stale wall clock when the user returns from the lock screen and snaps to the last word for a frame.

## The WordBoundary root cause

A long-running "some voices don't emit WordBoundary events" mystery was never per-voice. **edge-tts 7.x requests SentenceBoundary by default**, and which one a request got depended on the server node.

Fix: request WordBoundary explicitly, retry on zero events, and fill dead chunks with synthetic timings anchored to ffprobe windows. As a final fallback, `_do_chapter` calls `_generate_synthetic_timings`, distributing words evenly across the chapter's audio duration — karaoke still works, just less precisely.

## Storage

Timings live **on the CDN, not in Postgres**: `audiobook_chapters.word_timings_url` points at a JSON file on Cloudinary. The `word_timings` column is legacy. Full model and the two-client-generation contract: [word-timings storage](word-timings-storage.md).

Before the move, a chapter INSERT carrying a large timings blob could hit Supabase's statement timeout (`57014`); the code then stripped the timings and saved the chapter anyway, so audio played but follow-along silently vanished on almost every long book. Moving the blob off the INSERT removed the failure mode entirely — see [the incident](../incidents/karaoke-timings-statement-timeout.md).

## No "refresh existing books"

The schema stores audio URLs and timings, **not the source text**, so timings can't be regenerated without re-synthesising from text the server no longer has. Re-uploading the same file and deleting the old audiobook is the workflow.

## Related

- [Word-timings storage](word-timings-storage.md)
- [Audio playback](audio-playback.md)
- [Multi-language](multilanguage.md) — timings are generated per voice
