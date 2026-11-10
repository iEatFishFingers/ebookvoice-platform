/**
 * Frontend mirror of the backend's MAX_CONVERSION_WORDS gate
 * (see `epub_to_audio.py:MAX_CONVERSION_WORDS`, default 500_000).
 *
 * The backend is the source of truth — even if the frontend gate is bypassed
 * (older app build, edited chapters after upload, etc.), `/convert-chapters`
 * still rejects oversized payloads with HTTP 413 + `too_large: true`.
 *
 * The frontend gate exists for **UX only**: reject obviously-too-big books
 * the moment we know the word count (right after /extract-chapters), so
 * users don't waste time picking language + voice for a book that'll fail.
 *
 * If you bump the backend env var `MAX_CONVERSION_WORDS` (e.g. after a Render
 * RAM upgrade), bump this value too — or push it through the backend later.
 */
export const MAX_CONVERSION_WORDS = 500_000;
