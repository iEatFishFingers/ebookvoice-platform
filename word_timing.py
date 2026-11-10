"""
word_timing.py
==============
Extracts word-level timing data from Microsoft Edge TTS using its
WordBoundary events, emitted during audio streaming.

The output is a plain JSON array stored in the audiobook_chapters table.
The frontend uses binary search over this array to highlight the current
word during playback (karaoke mode).

Edge TTS timing resolution: 100-nanosecond ticks (1 tick = 100ns).
"""

import asyncio
import re
import shutil
import tempfile
import os
from typing import List, Dict, Any, Optional

import edge_tts

# 10,000,000 ticks = 1 second (100ns per tick)
TICKS_PER_SECOND = 1e7

# Chapters longer than this are split into parallel chunks.
#
# "Edge-tts handles ~1 000-word chunks reliably" was true until 2026-10-16,
# when Microsoft began refusing a share of requests outright (NoAudioReceived
# after ~3 s) and the refusal rate turned out to scale with REQUEST SIZE.
# Measured the same afternoon, same voice, same text, sequentially:
#
#     4 words   → OK            200 words → OK (56 s)
#    50 words   → OK            500 words → refused, 2.9 s
#                               718 words → refused, 2.9 s
#
# A refused 500-word chunk then succeeded on retry, so it is probabilistic,
# not a hard ceiling — but a 1 000-word chunk sits deep in the band where
# refusal is the common case. A rescue run at this size spent 10 minutes
# retrying and completed ZERO chapters, so retry alone does not save it.
# Override per-run with CHUNK_MAX_WORDS while the right default is measured.
# → [[edge-tts-throttle-silent-chapter-loss]]
CHUNK_MAX_WORDS = int(os.environ.get('CHUNK_MAX_WORDS', '1000'))

_FFMPEG_BIN = shutil.which('ffmpeg')  # None if not installed
_FFPROBE_BIN = shutil.which('ffprobe')  # None if not installed

# Floor on per-word duration after sanitisation.  Survives pathological
# overlaps where two words have identical or near-identical start times
# (rare edge-tts behaviour around prosody adjustments).  10 ms is well
# below human perception of word changes.
_MIN_WORD_DURATION_S = 0.01

# Fallback estimate for trailing silence at the end of a TTS chunk when
# ffprobe isn't available.  Empirically edge-tts adds ~500 ms of silence
# after sentence-end punctuation; this is a closer estimate than 0.
_CHUNK_TRAILING_SILENCE_FALLBACK_S = 0.5

# Retries when Microsoft REFUSES synthesis outright (NoAudioReceived after
# ~3 s).  Rate limiting is probabilistic, so a retry on a fresh WebSocket
# usually lands.  4 attempts with 5 s doubling = up to 35 s of waiting for a
# chunk that would otherwise be lost silently — cheap next to losing it.
# Override for one-off bulk/rescue runs with SYNTH_MAX_ATTEMPTS.
_SYNTH_MAX_ATTEMPTS = int(os.environ.get('SYNTH_MAX_ATTEMPTS', '4'))
_SYNTH_BACKOFF_BASE_S = float(os.environ.get('SYNTH_BACKOFF_BASE_S', '5'))


# ─── Word-timing sanitisation ───────────────────────────────────────────────
#
# Edge TTS' WordBoundary events have three quirks that, left raw, cause
# observable karaoke drift:
#
#  1. Punctuation tokens — some voices emit a separate event for "," or "—"
#     with a near-zero duration.  Those collide with the previous word in
#     time, breaking the binary search on the frontend.
#
#  2. Out-of-order events — rarely, prosody adjustments cause two events
#     to arrive with start times that go backwards by a few ms.  The
#     frontend's binary search assumes a sorted array.
#
#  3. Trailing pauses — edge-tts inserts ~500 ms of silence after a
#     sentence-end word (`.`, `!`, `?`).  The audio plays through that
#     silence; the timing array's `end` is the last syllable boundary;
#     the binary search has nothing to match during the pause and the
#     highlight unhighlights or skips ahead.  Fix: extend each word's
#     `end` to the next word's `start`, so the highlight stays on the
#     just-finished word until the next one begins.

_PUNCTUATION_ONLY = re.compile(r'^[^\w]+$')


def sanitize_word_timings(word_timings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Clean and pause-absorb a raw WordBoundary list.

    Steps:
      1. Drop entries whose `word` is empty or pure punctuation
         (those occasionally come from edge-tts and cause binary-search
         landings on near-zero-duration intervals).
      2. Sort by `start` to defend against any non-monotonic ordering.
      3. Drop entries with `end <= start` (zero-duration after sort).
      4. Extend each remaining word's `end` to the next word's `start`,
         so trailing TTS pauses become part of the just-finished word's
         "active" window.  The last word keeps its own `end`.

    Returns a new list; the input is not mutated.  Output is monotonically
    non-decreasing in both `start` and `end`.
    """
    if not word_timings:
        return []

    cleaned = []
    for wt in word_timings:
        word = (wt.get('word') or '').strip()
        if not word:
            continue
        if _PUNCTUATION_ONLY.match(word):
            continue
        cleaned.append({
            'word': word,
            'start': float(wt.get('start', 0)),
            'end': float(wt.get('end', 0)),
        })

    if not cleaned:
        return []

    cleaned.sort(key=lambda wt: wt['start'])
    cleaned = [wt for wt in cleaned if wt['end'] > wt['start']]

    if not cleaned:
        return []

    # Round FIRST — if we did the boundary-sharing pass before rounding,
    # independent rounding of adjacent (originally-equal) end/start values
    # could re-introduce ±0.001 s gaps after the share.  Rounding the
    # `start` values first means the boundary loop sees already-rounded
    # targets and the share holds exactly.
    for wt in cleaned:
        wt['start'] = round(wt['start'], 3)
        wt['end'] = round(wt['end'], 3)

    # Make every adjacent pair share a boundary: each word's `end` becomes
    # the next word's (already-rounded) `start`.  This:
    #   - Absorbs trailing TTS pauses (extends `end` forward through silence)
    #   - Eliminates overlapping intervals (clamps `end` back when raw timings
    #     would have produced an overlap)
    #
    # Result: a strictly non-overlapping, gapless array — the binary search
    # always lands on exactly one word for any in-range position.  The last
    # word keeps its own `end`.  The MIN_WORD_DURATION_S floor prevents
    # zero-duration entries when extreme overlaps would push end <= start.
    for i in range(len(cleaned) - 1):
        next_start = cleaned[i + 1]['start']
        cleaned[i]['end'] = max(cleaned[i]['start'] + _MIN_WORD_DURATION_S, next_start)

    return cleaned


def _probe_audio_duration_seconds(path: str) -> Optional[float]:
    """
    Return the audio file's exact duration in seconds via ffprobe, or
    None if ffprobe isn't available or the probe fails.

    Used during multi-chunk merge to compute the precise time-offset
    between chunks — using the last WordBoundary's `end` underestimates
    by the trailing-silence duration (~500 ms after sentence-end words),
    which then accumulates across chunk boundaries.

    Returns None on any failure mode — including a successful probe that
    returns 0 (which would happen if the file is mid-write or empty;
    treating 0 as "real duration" would zero out the chunk offset, which
    is worse than the fallback estimate).
    """
    if not _FFPROBE_BIN:
        return None
    try:
        import subprocess
        result = subprocess.run(
            [_FFPROBE_BIN, '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'csv=p=0', path],
            capture_output=True, timeout=10,
        )
        if result.returncode != 0:
            print(f'[word_timing] ffprobe non-zero exit on {path}: '
                  f'{result.stderr.decode()[:120]}')
            return None
        out = result.stdout.decode().strip()
        if not out:
            return None
        duration = float(out)
        return duration if duration > 0 else None
    except Exception as e:
        print(f'[word_timing] ffprobe failed on {path}: {e}')
        return None


def split_text_into_chunks(text: str, max_words: int = CHUNK_MAX_WORDS) -> List[str]:
    """
    Split text at sentence boundaries into segments of at most max_words words.
    Sentences are never broken mid-way. Returns at least one element.
    """
    sentences = re.split(r'(?<=[.!?…])\s+', text.strip())
    chunks: List[str] = []
    current: List[str] = []
    current_wc = 0
    for sentence in sentences:
        wc = len(sentence.split())
        if current and current_wc + wc > max_words:
            chunks.append(' '.join(current))
            current = [sentence]
            current_wc = wc
        else:
            current.append(sentence)
            current_wc += wc
    if current:
        chunks.append(' '.join(current))
    return chunks or [text]


def _concat_mp3_files(chunk_paths: List[str], output_path: str) -> None:
    """
    Join MP3 files into one.

    Prefers ffmpeg (concat demuxer) when available — it handles VBR headers
    cleanly. Falls back to raw binary concatenation which is valid for the
    48 kbps CBR mono MP3 that Edge TTS produces (verified against six
    production files 2026-09-11 — earlier docs said 128 kbps, which was wrong).
    """
    dir_name = os.path.dirname(output_path) or '.'
    tmp_fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix='.mp3.tmp')
    os.close(tmp_fd)
    try:
        if _FFMPEG_BIN:
            concat_list = tmp_path + '.txt'
            with open(concat_list, 'w') as f:
                for p in chunk_paths:
                    f.write(f"file '{p}'\n")
            import subprocess
            # -f mp3 on the OUTPUT is required, not optional: tmp_path ends in
            # '.mp3.tmp' (mkstemp suffix), and ffmpeg infers the muxer from the
            # extension, so without it every call dies with
            #   Error initializing the muxer for <...>.mp3.tmp: Invalid argument
            # This path had therefore never worked anywhere — it was dead code
            # because no environment had ffmpeg installed, and the binary
            # fallback below silently covered for it. Installing ffmpeg on
            # 2026-10-16 to get exact ffprobe chunk durations activated it and
            # broke every multi-chunk chapter mid-rescue: chunks synthesised
            # fine, then the merge threw the work away.
            result = subprocess.run(
                [_FFMPEG_BIN, '-y', '-f', 'concat', '-safe', '0',
                 '-i', concat_list, '-acodec', 'copy', '-f', 'mp3', tmp_path],
                capture_output=True, timeout=120,
            )
            os.unlink(concat_list)
            if result.returncode != 0:
                # Keep the tail, not the head — ffmpeg's banner occupies the
                # first ~200 chars, so slicing from the front shows the version
                # string instead of the error.
                raise RuntimeError(
                    f'ffmpeg concat failed: {result.stderr.decode()[-300:]}')
        else:
            # Binary concat — valid for CBR MP3 (edge-tts outputs 48 kbps CBR mono)
            with open(tmp_path, 'wb') as out:
                for p in chunk_paths:
                    with open(p, 'rb') as f:
                        out.write(f.read())
        os.replace(tmp_path, output_path)
    except Exception:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


async def _generate_with_event_retry(
    text: str,
    voice: str,
    output_mp3_path: str,
    rate: str = '+0%',
    pitch: str = '+0Hz',
    volume: str = '+0%',
    progress_callback=None,
) -> List[Dict[str, Any]]:
    """
    generate_audio_with_timings, hardened against two different transients.

    1. REFUSED SYNTHESIS (added 2026-10-16). Microsoft rate-limits the edge
       read-aloud endpoint and refuses a share of requests outright, raising
       NoAudioReceived after ~3 s. It is probabilistic, not a property of the
       text: a 500-word chunk that was refused twice in 2.9 s succeeded on the
       next attempt and streamed 826 KB at full speed. Longer chunks are
       refused more often.

       Until today nothing retried this. The exception propagated to the
       chapter-level handler in epub_to_audio.py, which swallowed it and
       returned None — so a refused chunk silently cost the whole chapter
       while the progress counter still advanced. One customer's 77-chapter
       book saved as 25 chapters, marked `complete`, with no error recorded.
       Retrying here (per CHUNK, not per chapter) is what makes that safe:
       a 3-chunk chapter needs all 3 chunks in one pass, so retrying the
       chapter compounds the failure odds while retrying each chunk does not.
       → [[edge-tts-throttle-silent-chapter-loss]]

    2. ZERO WORDBOUNDARY EVENTS. Synthesis produced audio but no timing
       metadata — a transient per-connection failure (an Azure edge node that
       ignores the metadata request), not a property of the voice. A fresh
       WebSocket almost always lands on a healthy node, so one retry turns
       most would-be synthetic-fallback chunks into precisely-timed ones.
    """
    timings = None
    for attempt in range(1, _SYNTH_MAX_ATTEMPTS + 1):
        try:
            timings = await generate_audio_with_timings(
                text, voice, output_mp3_path,
                rate=rate, pitch=pitch, volume=volume,
                progress_callback=progress_callback,
            )
            break
        except Exception as e:
            if attempt >= _SYNTH_MAX_ATTEMPTS:
                print(f'[word_timing] synthesis refused {_SYNTH_MAX_ATTEMPTS}x '
                      f'({type(e).__name__}) — giving up on this chunk')
                raise
            delay = _SYNTH_BACKOFF_BASE_S * (2 ** (attempt - 1))
            print(f'[word_timing] synthesis refused ({type(e).__name__}) on '
                  f'attempt {attempt}/{_SYNTH_MAX_ATTEMPTS} for '
                  f'{len(text.split())} words — retrying in {delay:.0f}s')
            await asyncio.sleep(delay)
    if not timings and len(text.split()) >= 5:
        print(f'[word_timing] zero WordBoundary events from {voice} — retrying once')
        timings = await generate_audio_with_timings(
            text, voice, output_mp3_path,
            rate=rate, pitch=pitch, volume=volume,
            progress_callback=progress_callback,
        )
        if timings:
            print(f'[word_timing] retry recovered {len(timings)} word events')
        else:
            print('[word_timing] retry also returned zero events — synthetic fill will cover')
    return timings


async def synthesize_in_chunks_async(
    text: str,
    voice: str,
    output_mp3_path: str,
    rate: str = '+0%',
    pitch: str = '+0Hz',
    volume: str = '+0%',
    progress_callback=None,
    chunk_max_words: int = CHUNK_MAX_WORDS,
) -> List[Dict[str, Any]]:
    """
    Synthesise text by splitting into chunks and running all in parallel.

    For short texts (≤ chunk_max_words) this is equivalent to a single call
    to generate_audio_with_timings. For long texts it runs N chunks
    concurrently via asyncio.gather, then joins the MP3 files and offsets
    the word timings so they reference positions in the merged audio.

    Returns the merged word-timing list (same format as generate_audio_with_timings).
    """
    chunks = split_text_into_chunks(text, max_words=chunk_max_words)

    if len(chunks) == 1:
        raw = await _generate_with_event_retry(
            text, voice, output_mp3_path,
            rate=rate, pitch=pitch, volume=volume,
            progress_callback=progress_callback,
        )
        sanitized = sanitize_word_timings(raw)
        print(f'[word_timing] sanitize: {len(raw)} → {len(sanitized)} entries')
        return sanitized

    total_chunks = len(chunks)
    chunk_word_counts = [len(c.split()) for c in chunks]
    total_words = max(1, sum(chunk_word_counts))

    # Cumulative word count before each chunk (for proportional progress)
    words_before = [0] * total_chunks
    for i in range(1, total_chunks):
        words_before[i] = words_before[i - 1] + chunk_word_counts[i - 1]

    print(f'[chunk] {total_chunks} chunks | words per chunk: {chunk_word_counts}')

    dir_name = os.path.dirname(output_mp3_path) or '.'
    base = os.path.basename(output_mp3_path)
    chunk_paths = [os.path.join(dir_name, f'_ck{i}_{base}') for i in range(total_chunks)]

    def make_chunk_cb(ci: int):
        if progress_callback is None:
            return None
        wb, cw = words_before[ci], chunk_word_counts[ci]
        def cb(fraction):
            progress_callback(min((wb + cw * fraction) / total_words, 0.99))
        return cb

    try:
        # Cap concurrent chunks per chapter. Each chunk opens a WebSocket to
        # edge-tts + SSL + aiohttp client (~7-10 MB resident). With the outer
        # PARALLEL_CHAPTER_WORKERS=2 already running two chapters at once,
        # an uncapped asyncio.gather here would spin up `n_chunks × 2` streams
        # and OOM Render Starter on long books (Think and Grow Rich had ~6
        # chunks per chapter = 12 concurrent streams = ~100 MB just for TTS).
        #
        # 1 chunk per chapter → 2 streams total system-wide (2 chapters × 1).
        # Was 2 (→ 4 streams) until 2026-10-16, when 4 streams started drawing
        # `NoAudioReceived` from Microsoft on roughly 70% of chapters: the
        # WebSocket connects, the request is accepted, and no audio is ever
        # sent. Because there is no retry around synthesis, every throttled
        # chapter was silently dropped while the progress counter still
        # advanced — one customer's 77-chapter book saved as 25 chapters and
        # was marked `complete` with no error. 2 streams matches the level
        # measured as safe on 2026-05-27, where 4 parallel was *slower* net
        # once throttling was accounted for. Halves peak TTS memory too.
        # See [[edge-tts-throttle-silent-chapter-loss]].
        chunk_sem = asyncio.Semaphore(1)

        async def _gen_bounded(idx: int):
            async with chunk_sem:
                return await _generate_with_event_retry(
                    chunks[idx], voice, chunk_paths[idx],
                    rate=rate, pitch=pitch, volume=volume,
                    progress_callback=make_chunk_cb(idx),
                )

        results: List[List[Dict]] = await asyncio.gather(*[
            _gen_bounded(i) for i in range(total_chunks)
        ])

        # Merge word timings — offset each chunk by the *actual* audio
        # duration of the preceding chunks.  Using the last WordBoundary's
        # `end` (the previous behaviour) underestimates by the trailing-
        # silence duration that edge-tts inserts after sentence-end words
        # (~500 ms).  That underestimate accumulates across boundaries and
        # is the visible "drift over time" in long chapters.
        merged: List[Dict[str, Any]] = []
        time_offset = 0.0
        for i, chunk_timings in enumerate(results):
            # Probe the chunk's true audio duration up front — needed both
            # for the inter-chunk offset AND to anchor a synthetic fill.
            real_duration = _probe_audio_duration_seconds(chunk_paths[i])

            if not chunk_timings and chunks[i].split():
                # This chunk produced audio but no WordBoundary events even
                # after the retry. Previously its words simply VANISHED from
                # the merged array — a silent mid-chapter highlighting hole
                # (and the chapter-level fallback never fired because the
                # OTHER chunks' timings made the list non-empty). Fill just
                # this chunk with weighted synthetic timings anchored to its
                # measured audio window; every other chunk keeps its precise
                # event-based timings.
                fill_duration = real_duration if real_duration is not None \
                    else chunk_word_counts[i] / 2.5
                chunk_timings = generate_synthetic_timings(
                    chunks[i], fill_duration, voice_id=voice)
                print(f'[word_timing] chunk {i + 1}/{total_chunks}: synthetic '
                      f'fill for {len(chunk_timings)} words '
                      f'({fill_duration:.1f}s window)')

            for wt in chunk_timings:
                merged.append({
                    'word': wt['word'],
                    'start': round(wt['start'] + time_offset, 3),
                    'end': round(wt['end'] + time_offset, 3),
                })
            # Prefer the chunk's true audio duration (via ffprobe).  Fall back
            # to last-word's-end + 0.5 s padding when ffprobe isn't available
            # — the padding approximates the typical trailing silence and is
            # closer than the unpadded value.
            if real_duration is not None:
                time_offset += real_duration
            elif chunk_timings:
                time_offset += chunk_timings[-1]['end'] + _CHUNK_TRAILING_SILENCE_FALLBACK_S
            else:
                # Estimate from word count (~2.5 wps) as last resort.
                time_offset += chunk_word_counts[i] / 2.5

        # Join the chunk audio files
        _concat_mp3_files(chunk_paths, output_mp3_path)
        print(f'[chunk] merged {total_chunks} chunks → {output_mp3_path}')
        sanitized = sanitize_word_timings(merged)
        print(f'[word_timing] sanitize: {len(merged)} → {len(sanitized)} entries')
        return sanitized

    finally:
        for p in chunk_paths:
            try:
                if os.path.exists(p):
                    os.unlink(p)
            except OSError:
                pass


async def generate_audio_with_timings(
    text: str,
    voice: str,
    output_mp3_path: str,
    rate: str = "+0%",
    pitch: str = "+0Hz",
    volume: str = "+0%",
    progress_callback=None,
) -> List[Dict[str, Any]]:
    """
    Stream Edge TTS audio to a file and capture WordBoundary events.

    Returns a list of timing dicts: [{word, start, end}, ...]
    where start and end are in seconds (float, 3 decimal places).

    The output_mp3_path file is written atomically via a temp file to
    prevent partial writes if the process is interrupted.

    rate/pitch/volume are passed directly to edge_tts.Communicate and must
    use the edge_tts format: rate/volume as "+X%" strings, pitch as "+XHz".

    progress_callback(fraction: float) is called periodically (every 50 words)
    with a 0.0–1.0 fraction representing within-chapter completion.
    """
    # boundary="WordBoundary" MUST be explicit. edge-tts 7.x defaults the
    # requested metadata type to SentenceBoundary, and which type actually
    # arrives then varies by whichever Azure edge node answers — that node
    # lottery is the root cause of the intermittent "voice emitted zero
    # WordBoundary events → synthetic fallback" chapters (probed 2026-07-03:
    # Ryan/Dalia/Svetlana all emit full word events when explicitly asked).
    try:
        communicate = edge_tts.Communicate(
            text, voice, rate=rate, pitch=pitch, volume=volume,
            boundary="WordBoundary",
        )
    except TypeError:
        # Older edge-tts without the boundary kwarg (pre-7.x) always
        # requested word boundaries — safe to fall back.
        communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume)
    word_timings: List[Dict[str, Any]] = []

    total_words = max(1, len(text.split()))
    words_done = 0
    _REPORT_EVERY = 50  # fire callback every N WordBoundary events

    dir_name = os.path.dirname(output_mp3_path) or "."
    tmp_fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".mp3.tmp")

    try:
        with os.fdopen(tmp_fd, "wb") as audio_file:
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio_file.write(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    start_s = chunk["offset"] / TICKS_PER_SECOND
                    duration_s = chunk["duration"] / TICKS_PER_SECOND
                    word_timings.append(
                        {
                            "word": chunk["text"],
                            "start": round(start_s, 3),
                            "end": round(start_s + duration_s, 3),
                        }
                    )
                    words_done += 1
                    if progress_callback and words_done % _REPORT_EVERY == 0:
                        progress_callback(min(words_done / total_words, 0.99))
        # Atomic rename — avoids serving a half-written file
        os.replace(tmp_path, output_mp3_path)
    except Exception:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise

    return word_timings


_SENTENCE_END = re.compile(r'[.!?]$')


def group_word_timings_into_chunks(
    word_timings: List[Dict[str, Any]],
    max_chunk_size: int = 3,
) -> List[Dict[str, Any]]:
    """
    Group word-level timings into phrase-level chunks that match the karaoke
    highlight rule used by the frontend KaraokeReader.

    Rules (identical to KaraokeReader.tsx):
      - A chunk closes when a sentence-terminal character (.!?) is the LAST
        character of a word, OR when max_chunk_size words have accumulated.
      - chunk['start'] = first word's TTS start time (exact, from WordBoundary).
      - chunk['end']   = next chunk's first word's TTS start time.
                         This absorbs any trailing TTS pause — pauses are
                         typically ~500 ms after sentence-end (.!?), ~200 ms
                         after a clause comma, and near-zero between plain words.
                         For the last chunk, end = last word's own end time.
      - chunk['word']  = the words joined with spaces (e.g. "The quick brown").

    Why this improves sync over word-level storage:
      - The frontend no longer needs to build chunks at render time.
      - The binary search array is ~3x smaller (faster seek).
      - Pause absorption: the karaoke highlight stays on the current phrase
        through the natural TTS pause, then advances exactly when the voice
        starts the next phrase — regardless of which voice is used, because all
        timings come directly from that voice's WordBoundary events.

    Falls back gracefully on empty input.
    """
    if not word_timings:
        return []

    chunks: List[Dict[str, Any]] = []
    chunk_words: List[str] = []
    chunk_start: float = word_timings[0]['start']

    for i, wt in enumerate(word_timings):
        if not chunk_words:
            chunk_start = wt['start']
        chunk_words.append(wt['word'])

        at_sentence_end = bool(_SENTENCE_END.search(wt['word']))
        at_max = len(chunk_words) >= max_chunk_size

        if at_sentence_end or at_max:
            # End = next word's start so trailing pause belongs to this chunk.
            if i + 1 < len(word_timings):
                chunk_end = word_timings[i + 1]['start']
            else:
                chunk_end = wt['end']

            chunks.append({
                'word': ' '.join(chunk_words),
                'start': round(chunk_start, 3),
                'end': round(chunk_end, 3),
            })
            chunk_words = []

    # Trailing words that didn't reach a boundary.
    if chunk_words:
        chunks.append({
            'word': ' '.join(chunk_words),
            'start': round(chunk_start, 3),
            'end': round(word_timings[-1]['end'], 3),
        })

    return chunks


def timings_to_vtt(word_timings: List[Dict[str, Any]]) -> str:
    """
    Convert a word-timings list to WebVTT format.

    Useful if you want to serve subtitles directly to the HTML5 <track>
    element on the web platform.
    """
    lines = ["WEBVTT", ""]
    for i, timing in enumerate(word_timings):
        start = _seconds_to_vtt_time(timing["start"])
        end = _seconds_to_vtt_time(timing["end"])
        lines += [str(i + 1), f"{start} --> {end}", timing["word"], ""]
    return "\n".join(lines)


def _seconds_to_vtt_time(seconds: float) -> str:
    """Format seconds as WebVTT timestamp: HH:MM:SS.mmm"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"

# ─── Synthetic (estimated) timings — the no-events fallback ────────────────
def generate_synthetic_timings(
    text: str,
    duration_seconds: float,
    voice_id: str = "",
) -> list:
    """
    Generate approximate word-level timings when Edge TTS does not emit
    WordBoundary events for a given voice (e.g. en-US-AnaNeural).

    Uses the Cloudinary-returned duration as a hard anchor so timestamps never
    drift beyond the actual audio length.  Weights each word by:
      - alphanumeric character count (longer words take more time to say)
      - extra virtual chars for TTS pauses caused by trailing punctuation
      - extra weight for words that end a paragraph (double-newline boundary)

    Per-word duration is capped at 3x the average word duration to prevent
    paragraph-break weights from creating multi-second highlight gaps.

    Typical Edge TTS pause durations this approximates:
      sentence (.!?)  -> ~500 ms  -> +6 virtual chars at avg 5 chars/word pace
      clause   (,;:)  -> ~200 ms  -> +2 virtual chars
      paragraph break -> ~800 ms  -> +10 virtual chars (applied to last word of para)
    """
    # Load per-voice words_per_second cap from voice_cache.json (best-effort)
    import json
    _wps_cap = None
    try:
        _cache_path = os.path.join(os.path.dirname(__file__), "voice_cache.json")
        with open(_cache_path, "r", encoding="utf-8") as _f:
            _cache = json.load(_f)
        _voice_data = _cache.get("voices", {}).get(voice_id, {})
        _wps = _voice_data.get("words_per_second")
        if _wps and 0 < _wps <= 20:  # sanity: 20 wps is faster than any human speaker
            # Max duration per word = 3 / wps  (e.g. 3/2.8 approx 1.07 s)
            _wps_cap = 3.0 / _wps
    except Exception:
        pass  # cache unavailable - proceed without cap

    # Replace paragraph breaks with a special sentinel before splitting
    normalized = re.sub(r'\n{2,}', ' \x00 ', text)
    normalized = re.sub(r'\n', ' ', normalized)
    tokens = re.findall(r'\S+', normalized)

    # Build (word, extra_pause_weight) pairs
    word_entries = []
    for token in tokens:
        if token == '\x00':
            # paragraph break - add pause weight to the previous word
            if word_entries:
                word_entries[-1] = (word_entries[-1][0], word_entries[-1][1] + 10)
        else:
            word_entries.append((token, 0))

    if not word_entries or duration_seconds <= 0:
        return []

    def _word_weight(word, extra):
        # Base: alphanumeric chars only (punctuation chars do not take speech time)
        base = max(1, len(re.sub(r'[^\w]', '', word)))
        # Trailing punctuation adds pause weight
        if re.search(r'[.!?]+$', word):
            base += 6   # ~sentence pause ~500 ms
        elif re.search(r'[,;:\u2014\u2013]+$', word):
            base += 2   # ~clause pause ~200 ms
        return base + extra

    weights = [_word_weight(w, e) for w, e in word_entries]
    total_weight = sum(weights)

    # First pass: compute raw durations
    raw_durations = [(w / total_weight) * duration_seconds for w in weights]

    # Second pass: apply per-word cap iteratively until no excess remains.
    # One pass can push previously-uncapped words over the cap, generating
    # secondary excess; we repeat until convergence (max n iterations).
    if _wps_cap is not None:
        durations = list(raw_durations)
        for _ in range(len(durations)):
            excess = sum(max(0.0, d - _wps_cap) for d in durations)
            if excess < 1e-9:
                break
            # Clamp all over-cap words
            durations = [min(d, _wps_cap) for d in durations]
            # Redistribute excess proportionally to still-uncapped words
            uncapped_indices = [i for i, d in enumerate(durations) if d < _wps_cap]
            if not uncapped_indices:
                break  # every word is at cap — nowhere to redistribute
            uncapped_total = sum(durations[i] for i in uncapped_indices)
            if uncapped_total <= 0:
                break
            scale = (uncapped_total + excess) / uncapped_total
            for i in uncapped_indices:
                durations[i] *= scale
        raw_durations = durations

    # Anchor the final word's end exactly to duration_seconds to eliminate
    # floating-point accumulation drift across the word list.
    timings = []
    current_time = 0.0
    for i, ((word, _), word_duration) in enumerate(zip(word_entries, raw_durations)):
        start = round(current_time, 3)
        if i == len(word_entries) - 1:
            end = round(duration_seconds, 3)
        else:
            end = round(current_time + word_duration, 3)
        timings.append({
            'word': word,
            'start': start,
            'end': end,
        })
        current_time += word_duration

    return timings
