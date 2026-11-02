import { getLocales } from 'expo-localization';

import type { Language } from '.';

/** Nem's language for a phone language code: Pidgin if the phone asks for it, else English. */
export function languageFor(code: string | null | undefined): Language {
  return code === 'pcm' ? 'pcm' : 'en';
}

/** The phone's language if Nem speaks it, else English. Used before the user picks one. */
export function deviceLanguage(): Language {
  try {
    return languageFor(getLocales()[0]?.languageCode);
  } catch {
    return 'en';
  }
}
