import { createInstance, type ParseKeys } from 'i18next';
import { initReactI18next } from 'react-i18next';

import { deviceLanguage, languageFor } from './deviceLanguage';
import en from './locales/en.json';

// Every user-facing string lives in locales/<language>.json (SET-2). English is
// the source and the fallback: a key missing in another language shows English,
// never the key. Strings are keyed by screen, e.g. t('settings.title').

export type Language = 'en' | 'pcm';

export const resources = { en: { translation: en } } as const;

const i18n = createInstance();

void i18n.use(initReactI18next).init({
  resources,
  lng: deviceLanguage(),
  fallbackLng: 'en',
  // Loaded in the bundle, so the first render already has its strings.
  initAsync: false,
  interpolation: { escapeValue: false },
  returnNull: false,
});

export type TranslationKey = ParseKeys;

/**
 * A lookup table (status → words) for module-level constants. Each value is
 * read in the current language when it is used, so a language change shows
 * up without a reload.
 */
export function localized<K extends string>(
  keys: Record<K, TranslationKey>,
): Readonly<Record<K, string>> {
  const table = {} as Record<K, string>;
  for (const key of Object.keys(keys) as K[]) {
    Object.defineProperty(table, key, { enumerable: true, get: () => i18n.t(keys[key]) });
  }
  return table;
}

export { deviceLanguage, languageFor };
export default i18n;
