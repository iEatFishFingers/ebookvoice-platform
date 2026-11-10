import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';
import { translate, isUiLanguageSupported, FALLBACK_LANGUAGE } from '../i18n';

/**
 * App-UI language. Mirrors ThemeContext deliberately (same load-on-mount +
 * AsyncStorage-persist shape) so it reads as one family with the rest of the
 * context layer.
 *
 * Two modes:
 *  - "follow device" (default): read the phone's language on launch and use it
 *    if we have a translation for it, otherwise English. Nothing is stored, so
 *    it re-detects each launch and tracks the phone if the user changes it.
 *  - "manual override": the user picked a language in Settings; we store the
 *    code and stop following the device until they choose "Match device" again.
 */

const LANGUAGE_STORAGE_KEY = '@app_language';

/** Read the phone language and map it to a UI language we actually ship (else English). */
function detectDeviceLanguage(): string {
  try {
    const tag = Localization.getLocales?.()[0]?.languageCode ?? '';
    const code = tag.toLowerCase().split('-')[0];
    return isUiLanguageSupported(code) ? code : FALLBACK_LANGUAGE;
  } catch {
    return FALLBACK_LANGUAGE;
  }
}

interface LanguageContextType {
  /** Active UI language code (always one we have a dictionary for). */
  language: string;
  /** True when following the device language rather than a manual choice. */
  followSystem: boolean;
  /** Translate a key (with optional {param} interpolation). */
  t: (key: string, params?: Record<string, string | number>) => string;
  /** Manually pick a UI language (persists, stops following the device). */
  setLanguage: (code: string) => void;
  /** Go back to following the device language (clears the manual choice). */
  useDeviceLanguage: () => void;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider = ({ children }: { children: ReactNode }) => {
  const [language, setLanguageState] = useState<string>(FALLBACK_LANGUAGE);
  const [followSystem, setFollowSystem] = useState<boolean>(true);

  useEffect(() => {
    loadLanguagePreference();
  }, []);

  const loadLanguagePreference = async () => {
    try {
      const saved = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);
      if (saved && isUiLanguageSupported(saved)) {
        setLanguageState(saved);
        setFollowSystem(false);
        return;
      }
    } catch (error) {
      console.error('Error loading language preference:', error);
    }
    // No valid saved override → follow the device.
    setLanguageState(detectDeviceLanguage());
    setFollowSystem(true);
  };

  const setLanguage = async (code: string) => {
    if (!isUiLanguageSupported(code)) return;
    setLanguageState(code);
    setFollowSystem(false);
    try {
      await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, code);
    } catch (error) {
      console.error('Error saving language preference:', error);
    }
  };

  const useDeviceLanguage = async () => {
    setLanguageState(detectDeviceLanguage());
    setFollowSystem(true);
    try {
      await AsyncStorage.removeItem(LANGUAGE_STORAGE_KEY);
    } catch (error) {
      console.error('Error clearing language preference:', error);
    }
  };

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => translate(language, key, params),
    [language],
  );

  return (
    <LanguageContext.Provider value={{ language, followSystem, t, setLanguage, useDeviceLanguage }}>
      {children}
    </LanguageContext.Provider>
  );
};

/** Full context (language + setters). */
export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
};

/** Convenience for screens that only need to translate. */
export const useTranslation = () => {
  const { t, language, setLanguage, useDeviceLanguage, followSystem } = useLanguage();
  return { t, language, setLanguage, useDeviceLanguage, followSystem };
};
