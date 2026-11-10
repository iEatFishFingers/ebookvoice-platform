/**
 * Hand-curated featured voice IDs per language family.
 *
 * Multilingual voices are preferred (highest quality tier from Microsoft).
 * Covers gender balance and the most widely understood regional accents.
 *
 * To update: edit the arrays here and optionally re-run
 * `python scripts/regenerate_voice_cache.py` if you've added a new locale.
 */
export const FEATURED_VOICE_IDS: Record<string, string[]> = {
  en: [
    'en-US-AndrewMultilingualNeural',
    'en-US-EmmaMultilingualNeural',
    'en-GB-SoniaNeural',
    'en-GB-RyanNeural',
  ],
  es: [
    'es-ES-AlvaroNeural',
    'es-ES-ElviraNeural',
    'es-MX-DaliaNeural',
    'es-MX-JorgeNeural',
  ],
  fr: [
    'fr-FR-RemyMultilingualNeural',
    'fr-FR-VivienneMultilingualNeural',
    'fr-CA-AntoineNeural',
  ],
  de: [
    'de-DE-FlorianMultilingualNeural',
    'de-DE-SeraphinaMultilingualNeural',
    'de-AT-IngridNeural',
  ],
  it: [
    'it-IT-GiuseppeMultilingualNeural',
    'it-IT-IsabellaNeural',
    'it-IT-ElsaNeural',
  ],
  pt: [
    'pt-BR-ThalitaMultilingualNeural',
    'pt-BR-AntonioNeural',
    'pt-PT-DuarteNeural',
  ],
  nl: [
    'nl-NL-ColetteNeural',
    'nl-NL-MaartenNeural',
    'nl-BE-DenaNeural',
  ],
  pl: [
    'pl-PL-ZofiaNeural',
    'pl-PL-MarekNeural',
  ],
  ru: [
    'ru-RU-SvetlanaNeural',
    'ru-RU-DmitryNeural',
  ],
  zh: [
    'zh-CN-XiaoxiaoNeural',
    'zh-CN-YunxiNeural',
    'zh-CN-YunyangNeural',
    'zh-TW-HsiaoChenNeural',
  ],
  ja: [
    'ja-JP-NanamiNeural',
    'ja-JP-KeitaNeural',
  ],
  ko: [
    'ko-KR-HyunsuMultilingualNeural',
    'ko-KR-SunHiNeural',
    'ko-KR-InJoonNeural',
  ],
  ar: [
    'ar-SA-ZariyahNeural',
    'ar-SA-HamedNeural',
    'ar-EG-SalmaNeural',
    'ar-EG-ShakirNeural',
  ],
  hi: [
    'hi-IN-SwaraNeural',
    'hi-IN-MadhurNeural',
  ],
  tr: [
    'tr-TR-EmelNeural',
    'tr-TR-AhmetNeural',
  ],
  cy: [
    'cy-GB-NiaNeural',
    'cy-GB-AledNeural',
  ],
  ga: [
    'ga-IE-OrlaNeural',
    'ga-IE-ColmNeural',
  ],
  uk: [
    'uk-UA-PolinaNeural',
    'uk-UA-OstapNeural',
  ],
  el: [
    'el-GR-AthinaNeural',
    'el-GR-NestorasNeural',
  ],
  he: [
    'he-IL-HilaNeural',
    'he-IL-AvriNeural',
  ],
  sv: [
    'sv-SE-SofieNeural',
    'sv-SE-MattiasNeural',
  ],
  da: [
    'da-DK-ChristelNeural',
    'da-DK-JeppeNeural',
  ],
  nb: [
    'nb-NO-PernilleNeural',
    'nb-NO-FinnNeural',
  ],
  fi: [
    'fi-FI-NooraNeural',
    'fi-FI-HarriNeural',
  ],
  cs: [
    'cs-CZ-VlastaNeural',
    'cs-CZ-AntoninNeural',
  ],
  hu: [
    'hu-HU-NoemiNeural',
    'hu-HU-TamasNeural',
  ],
  ro: [
    'ro-RO-AlinaNeural',
    'ro-RO-EmilNeural',
  ],
};

/** Extract the first-name portion from a voice display name.
 *  "Sonia (UK Female - Storytelling)" → "Sonia"
 *  "XiaoxiaoNeural" → "Xiaoxiao" (fallback for unusual names)
 */
export function voiceShortName(fullName: string): string {
  const beforeParen = fullName.split(' (')[0].trim();
  return beforeParen || fullName;
}

/** Extract the style tag from a voice display name.
 *  "Sonia (UK Female - Storytelling)" → "Storytelling"
 *  Returns empty string when no style tag is present.
 */
export function voiceStyleTag(fullName: string): string {
  const match = fullName.match(/- ([^)]+)\)$/);
  return match ? match[1].trim() : '';
}

/**
 * Human-readable region/country terms for each locale.
 * Used so users can search "Mexico", "British", "Brazil" etc. without
 * needing to know the locale code. Every term is lowercase for comparison.
 */
const LOCALE_SEARCH_TERMS: Record<string, string[]> = {
  // English variants
  'en-AU': ['australia', 'australian'],
  'en-CA': ['canada', 'canadian'],
  'en-GB': ['britain', 'british', 'uk', 'england', 'english'],
  'en-HK': ['hong kong'],
  'en-IE': ['ireland', 'irish'],
  'en-IN': ['india', 'indian'],
  'en-KE': ['kenya', 'kenyan'],
  'en-NG': ['nigeria', 'nigerian'],
  'en-NZ': ['new zealand'],
  'en-PH': ['philippines', 'filipino'],
  'en-SG': ['singapore'],
  'en-TZ': ['tanzania'],
  'en-US': ['america', 'american', 'united states', 'us'],
  'en-ZA': ['south africa'],
  // Spanish variants
  'es-AR': ['argentina', 'argentine'],
  'es-BO': ['bolivia', 'bolivian'],
  'es-CL': ['chile', 'chilean'],
  'es-CO': ['colombia', 'colombian'],
  'es-CR': ['costa rica'],
  'es-CU': ['cuba', 'cuban'],
  'es-DO': ['dominican'],
  'es-EC': ['ecuador'],
  'es-ES': ['spain', 'castilian', 'european spanish'],
  'es-GT': ['guatemala'],
  'es-HN': ['honduras'],
  'es-MX': ['mexico', 'mexican'],
  'es-NI': ['nicaragua'],
  'es-PA': ['panama'],
  'es-PE': ['peru', 'peruvian'],
  'es-PR': ['puerto rico'],
  'es-PY': ['paraguay'],
  'es-SV': ['el salvador'],
  'es-US': ['american spanish'],
  'es-UY': ['uruguay'],
  'es-VE': ['venezuela'],
  // French variants
  'fr-BE': ['belgium', 'belgian'],
  'fr-CA': ['canada', 'canadian', 'quebec'],
  'fr-FR': ['france'],
  // German variants
  'de-AT': ['austria', 'austrian'],
  'de-CH': ['switzerland', 'swiss'],
  'de-DE': ['germany'],
  // Italian
  'it-IT': ['italy'],
  // Portuguese
  'pt-BR': ['brazil', 'brazilian'],
  'pt-PT': ['portugal'],
  // Dutch
  'nl-BE': ['belgium', 'belgian', 'flemish'],
  'nl-NL': ['netherlands'],
  // Polish
  'pl-PL': ['poland'],
  // Russian
  'ru-RU': ['russia'],
  // Chinese
  'zh-CN': ['china', 'mandarin', 'simplified'],
  'zh-TW': ['taiwan', 'traditional', 'taiwanese'],
  'zh-HK': ['hong kong', 'cantonese'],
  // Japanese
  'ja-JP': ['japan'],
  // Korean
  'ko-KR': ['korea', 'south korea'],
  // Arabic
  'ar-SA': ['saudi', 'saudi arabia'],
  'ar-EG': ['egypt', 'egyptian'],
  'ar-AE': ['uae', 'dubai', 'emirati'],
  // Hindi
  'hi-IN': ['india', 'indian'],
  // Turkish
  'tr-TR': ['turkey'],
};

/**
 * Returns all searchable terms for a locale — the code itself plus
 * any human-readable country/region synonyms.
 * E.g. 'es-MX' → ['es-mx', 'mexico', 'mexican']
 */
export function localeSearchTerms(locale: string | undefined): string[] {
  if (!locale) return [];
  const code = locale.toLowerCase();
  return [code, ...(LOCALE_SEARCH_TERMS[locale] ?? [])];
}

/** Return the flag emoji for a locale, falling back to 🎙 */
export function localeFlag(locale: string | undefined): string {
  if (!locale) return '🎙';
  const flags: Record<string, string> = {
    'en-GB': '🇬🇧', 'en-US': '🇺🇸', 'en-AU': '🇦🇺', 'en-CA': '🇨🇦',
    'en-IN': '🇮🇳', 'en-IE': '🇮🇪', 'en-NZ': '🇳🇿', 'en-SG': '🇸🇬',
    'en-ZA': '🇿🇦', 'en-HK': '🇭🇰', 'en-KE': '🇰🇪', 'en-NG': '🇳🇬',
    'en-PH': '🇵🇭', 'en-TZ': '🇹🇿',
    'es-ES': '🇪🇸', 'es-MX': '🇲🇽', 'es-AR': '🇦🇷', 'es-CO': '🇨🇴',
    'es-US': '🇺🇸', 'es-CL': '🇨🇱', 'es-PE': '🇵🇪', 'es-VE': '🇻🇪',
    'fr-FR': '🇫🇷', 'fr-CA': '🇨🇦', 'fr-BE': '🇧🇪', 'fr-CH': '🇨🇭',
    'de-DE': '🇩🇪', 'de-AT': '🇦🇹', 'de-CH': '🇨🇭',
    'it-IT': '🇮🇹',
    'pt-BR': '🇧🇷', 'pt-PT': '🇵🇹',
    'nl-NL': '🇳🇱', 'nl-BE': '🇧🇪',
    'pl-PL': '🇵🇱',
    'ru-RU': '🇷🇺',
    'zh-CN': '🇨🇳', 'zh-TW': '🇹🇼', 'zh-HK': '🇭🇰',
    'ja-JP': '🇯🇵',
    'ko-KR': '🇰🇷',
    'ar-SA': '🇸🇦', 'ar-EG': '🇪🇬', 'ar-AE': '🇦🇪',
    'hi-IN': '🇮🇳',
    'tr-TR': '🇹🇷',
  };
  return flags[locale] ?? '🎙';
}
