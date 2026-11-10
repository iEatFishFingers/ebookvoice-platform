/**
 * Supported book languages for TTS conversion.
 *
 * Each entry's `code` is the ISO 639-1 language code matched against a voice's
 * `locale` prefix (e.g. code "en" matches voices with locale "en-GB", "en-US",
 * "en-AU", …). Native names match Wikipedia's "endonym" column.
 *
 * To add a language: append an entry here AND re-run
 * `python scripts/regenerate_voice_cache.py` so the backend ships voices for
 * the new locale.
 */

export interface SupportedLanguage {
  /** ISO 639-1 code, e.g. "en", "zh" */
  code: string;
  /** Self-name shown in the picker, e.g. "Español", "中文" */
  nativeName: string;
  /** Translated label, used for search matching */
  englishName: string;
  /** Single emoji shown to the left of the row */
  flag: string;
}

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  { code: 'en', nativeName: 'English',    englishName: 'English',    flag: '🇬🇧' },
  { code: 'es', nativeName: 'Español',    englishName: 'Spanish',    flag: '🇪🇸' },
  { code: 'fr', nativeName: 'Français',   englishName: 'French',     flag: '🇫🇷' },
  { code: 'de', nativeName: 'Deutsch',    englishName: 'German',     flag: '🇩🇪' },
  { code: 'it', nativeName: 'Italiano',   englishName: 'Italian',    flag: '🇮🇹' },
  { code: 'pt', nativeName: 'Português',  englishName: 'Portuguese', flag: '🇵🇹' },
  { code: 'nl', nativeName: 'Nederlands', englishName: 'Dutch',      flag: '🇳🇱' },
  { code: 'pl', nativeName: 'Polski',     englishName: 'Polish',     flag: '🇵🇱' },
  { code: 'ru', nativeName: 'Русский',    englishName: 'Russian',    flag: '🇷🇺' },
  { code: 'zh', nativeName: '中文',         englishName: 'Chinese',    flag: '🇨🇳' },
  { code: 'ja', nativeName: '日本語',       englishName: 'Japanese',   flag: '🇯🇵' },
  { code: 'ko', nativeName: '한국어',       englishName: 'Korean',     flag: '🇰🇷' },
  { code: 'ar', nativeName: 'العربية',     englishName: 'Arabic',     flag: '🇸🇦' },
  { code: 'hi', nativeName: 'हिन्दी',         englishName: 'Hindi',      flag: '🇮🇳' },
  { code: 'tr', nativeName: 'Türkçe',     englishName: 'Turkish',    flag: '🇹🇷' },
  { code: 'cy', nativeName: 'Cymraeg',    englishName: 'Welsh',      flag: '🏴󠁧󠁢󠁷󠁬󠁳󠁿' },
  { code: 'ga', nativeName: 'Gaeilge',    englishName: 'Irish',      flag: '🇮🇪' },
  { code: 'uk', nativeName: 'Українська', englishName: 'Ukrainian',  flag: '🇺🇦' },
  { code: 'el', nativeName: 'Ελληνικά',    englishName: 'Greek',      flag: '🇬🇷' },
  { code: 'he', nativeName: 'עברית',       englishName: 'Hebrew',     flag: '🇮🇱' },
  { code: 'sv', nativeName: 'Svenska',    englishName: 'Swedish',    flag: '🇸🇪' },
  { code: 'da', nativeName: 'Dansk',      englishName: 'Danish',     flag: '🇩🇰' },
  { code: 'nb', nativeName: 'Norsk',      englishName: 'Norwegian',  flag: '🇳🇴' },
  { code: 'fi', nativeName: 'Suomi',      englishName: 'Finnish',    flag: '🇫🇮' },
  { code: 'cs', nativeName: 'Čeština',    englishName: 'Czech',      flag: '🇨🇿' },
  { code: 'hu', nativeName: 'Magyar',     englishName: 'Hungarian',  flag: '🇭🇺' },
  { code: 'ro', nativeName: 'Română',     englishName: 'Romanian',   flag: '🇷🇴' },
];

export const DEFAULT_LANGUAGE_CODE = 'en';

/**
 * Resolve a possibly-tagged language string (e.g. "en-GB", "zh-Hans") to a
 * supported ISO 639-1 code. Returns null when the language family isn't
 * supported — callers typically fall back to DEFAULT_LANGUAGE_CODE.
 */
export function resolveSupportedLanguage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const prefix = raw.toLowerCase().split('-')[0];
  return SUPPORTED_LANGUAGES.some(l => l.code === prefix) ? prefix : null;
}

/**
 * Filter a voice list to those whose locale matches the given language family.
 * Used by VoiceSelectionScreen, SmartSetupScreen, and ChapterVoiceSelectionScreen.
 *
 * Multilingual voices (id contains "Multilingual", or flagged `multilingual`)
 * are always kept regardless of locale: they auto-detect language per segment
 * and are the only voices that handle mixed-language text, so a non-matching
 * home locale must not hide them.
 */
export function filterVoicesByLanguage<T extends { locale?: string; id?: string; multilingual?: boolean }>(
  voices: T[],
  languageCode: string,
): T[] {
  const prefix = `${languageCode.toLowerCase()}-`;
  return voices.filter(
    v =>
      (v.locale ?? '').toLowerCase().startsWith(prefix) ||
      v.multilingual === true ||
      (v.id ?? '').toLowerCase().includes('multilingual'),
  );
}
