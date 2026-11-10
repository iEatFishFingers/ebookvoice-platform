# Multi-language

**27 languages / 214 neural voices.** The pipeline is layered intentionally — language detection, voice filtering and synthesis are separate steps.

## Flow

```
Upload → /extract-chapters → LanguageSelection → EbookReview → SmartSetup (voice picker) → /convert-chapters → Conversion
```

## Backend

- **`security/epub_parser.py:extract_book_language()`** reads `<dc:language>` from the EPUB OPF and returns an ISO 639-1 code, stripping locale subtags (`en-GB` → `en`).
- **`/extract-chapters`** returns `{chapters, coverUrl, language, imageUploadId}`. `language` pre-selects the picker. `imageUploadId` references a background image upload in a daemon thread — chapters return immediately while images upload.
- **`/api/voices?lang=es`** filters server-side by locale prefix; the client always passes `lang`.
- **Native-language previews:** `PREVIEW_TEXTS` in `epub_to_audio.py` is keyed by ISO 639-1 code, so every voice previews in its own language. The cache filename prefix is `prevn_*` (vs. the older `preview_*`) so cached English-only previews are never served for non-English voices.
- **Audiobook duration:** after the chapter batch INSERT, the worker sums chapter durations into `audiobooks.duration`; the client computes progress as `position / duration`.
- **Multilingual voices** (which handle mixed-language text — e.g. EN + AR + ZH in one stream) are surfaced for every book regardless of its detected language, since they're the only voices that can read mixed-language text.

## The voice cache

`voice_cache.json` is committed with all 214 voices. Defaults in `voice_manager.py`:

```
VOICE_FILTER_LOCALES = 'en,es,fr,de,it,pt,nl,pl,ru,zh,ja,ko,ar,hi,tr,cy,ga,uk,el,he,sv,da,nb,fi,cs,hu,ro'
VOICE_CACHE_TTL_HOURS = 168   # 1 week
```

The code defaults are the source of truth. Setting `VOICE_FILTER_LOCALES` in the environment overrides them — if only English voices appear, check it hasn't been set.

## Adding a language

1. Add the ISO code to `_ALL_SUPPORTED` in `voice_manager.py`
2. Add it to `SUPPORTED_LANGUAGES` in `scripts/regenerate_voice_cache.py`
3. Add a native sentence to `PREVIEW_TEXTS` in `epub_to_audio.py`
4. Add entries to `mobile-app/src/constants/languages.ts` **and** `featuredVoices.ts`
5. Run `python scripts/regenerate_voice_cache.py`

Only add locales edge-tts actually has voices for (Scottish Gaelic, `gd-GB`, has none).

## Frontend

- **`constants/languages.ts`** — supported codes, flags, native names, and `filterVoicesByLanguage`.
- **`constants/featuredVoices.ts`** — ~4 curated voices per language for the Featured strip, plus `localeSearchTerms` so users can search "Mexican", "British" or "Brazilian" instead of locale codes.
- **`SmartSetupScreen`** — a featured strip plus a searchable All Voices list, sorted into three tiers (Featured → Multilingual → rest). It loads with a single `getVoices()` call. An earlier "AI director" that analysed chapter emotion and suggested voices was removed; `emotional_director.py` and `voice_suggester.py` remain in the backend but are no longer called by the client.

## Migrations

All additive; `task_manager.create_task` and `process_chapters_conversion` retry without these columns if a migration hasn't been applied.

- `005_audiobook_language.sql` — `audiobooks.language` + index
- `006_conversion_tasks_language.sql` — `conversion_tasks.language`
- `007_conversion_tasks_image_upload_id.sql` — `conversion_tasks.image_upload_id`

## Related

- [Discover](discover-catalog.md)
- [Karaoke timings](karaoke-timings.md) — timings are generated per voice
