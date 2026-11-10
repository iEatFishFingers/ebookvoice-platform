"""
Regenerate voice_cache.json with all supported language locales.

The cache file is checked into git and ships with the Render deploy, so
`/api/voices` returns voices for every supported language without depending
on the `VOICE_FILTER_LOCALES` env var being set on Render.

Run:    python scripts/regenerate_voice_cache.py
Output: writes voice_cache.json at the repo root.

To add or remove a language family, edit SUPPORTED_LANGUAGES below and re-run.
"""
from __future__ import annotations

import asyncio
import os
import sys

# Make the repo root importable so we can reuse VoiceManager.
HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
sys.path.insert(0, REPO_ROOT)

from voice_manager import VoiceManager  # noqa: E402


SUPPORTED_LANGUAGES = [
    'en',  # English
    'es',  # Spanish
    'fr',  # French
    'de',  # German
    'it',  # Italian
    'pt',  # Portuguese
    'nl',  # Dutch
    'pl',  # Polish
    'ru',  # Russian
    'zh',  # Chinese
    'ja',  # Japanese
    'ko',  # Korean
    'ar',  # Arabic
    'hi',  # Hindi
    'tr',  # Turkish
    'cy',  # Welsh
    'ga',  # Irish
    'uk',  # Ukrainian
    'el',  # Greek
    'he',  # Hebrew
    'sv',  # Swedish
    'da',  # Danish
    'nb',  # Norwegian (Bokmål)
    'fi',  # Finnish
    'cs',  # Czech
    'hu',  # Hungarian
    'ro',  # Romanian
]


async def main() -> int:
    cache_path = os.path.join(REPO_ROOT, 'voice_cache.json')
    vm = VoiceManager(
        cache_file=cache_path,
        cache_ttl_hours=24,
        filter_neural_only=True,
        filter_locales=SUPPORTED_LANGUAGES,
    )
    # force_refresh bypasses the in-memory + on-disk cache and re-fetches
    # from Microsoft Edge TTS.
    voices = await vm.get_voices(force_refresh=True)

    by_lang: dict[str, int] = {}
    for v in voices:
        prefix = (v.get('locale') or '').split('-')[0]
        by_lang[prefix] = by_lang.get(prefix, 0) + 1

    print(f'\nWrote {len(voices)} voices to {cache_path}')
    print('Voices per language:')
    for lang in SUPPORTED_LANGUAGES:
        print(f'  {lang}: {by_lang.get(lang, 0)}')

    missing = [lang for lang in SUPPORTED_LANGUAGES if by_lang.get(lang, 0) == 0]
    if missing:
        print(f'\n[!] WARNING: no voices fetched for: {", ".join(missing)}')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
