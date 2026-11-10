/**
 * i18n core — pure lookup, no React. The LanguageContext wraps this and feeds
 * it the active language; screens call t() via useTranslation().
 *
 * Design goals (per CLAUDE.md "lean & reliable"): zero new dependencies, English
 * fallback so a missing key can never render blank, and safe {param} interpolation.
 */
import { catalog, UI_LANGUAGE_CODES, LangCode } from './translations';
import { SUPPORTED_LANGUAGES } from '../constants/languages';

export { UI_LANGUAGE_CODES };

/** Fallback language — always complete, always present. */
export const FALLBACK_LANGUAGE: LangCode = 'en';

/**
 * True when we have a UI dictionary for this code (so the auto-switch may
 * switch to it). Everything else stays English until translated.
 */
export function isUiLanguageSupported(code: string | null | undefined): code is LangCode {
  return !!code && (UI_LANGUAGE_CODES as string[]).includes(code);
}

/**
 * Translate `key` into `lang`, falling back to English, then to the raw key
 * (so a typo shows the key instead of crashing). `params` fills {placeholders}.
 */
export function translate(
  lang: string,
  key: string,
  params?: Record<string, string | number>,
): string {
  const entry = catalog[key];
  const value =
    (entry && (entry[lang as LangCode] ?? entry.en)) ??
    key;

  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (match, name) =>
    name in params ? String(params[name]) : match,
  );
}

export interface UiLanguageOption {
  code: string;
  nativeName: string;
  englishName: string;
  flag: string;
}

/**
 * The languages offered in the manual picker — the UI-translated subset of the
 * full conversion-language list, so labels/flags stay consistent with the rest
 * of the app. Ordered by the rollout priority in translations.ts.
 */
export const UI_LANGUAGE_OPTIONS: UiLanguageOption[] = UI_LANGUAGE_CODES
  .map(code => SUPPORTED_LANGUAGES.find(l => l.code === code))
  .filter((l): l is (typeof SUPPORTED_LANGUAGES)[number] => !!l)
  .map(l => ({ code: l.code, nativeName: l.nativeName, englishName: l.englishName, flag: l.flag }));
