import type { Schema } from '@nem/contracts';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

// App settings (PRD FR-SET, AI-8). Kept on the device so the app starts in the
// right theme and language before any network call; synced with the server's
// copy through users.getPreferences / setPreferences.

export type ApiPreferences = Schema<'Preferences'>;
export type Appearance = ApiPreferences['appearance'];
export type Language = ApiPreferences['language'];
export type AutoLockSeconds = ApiPreferences['auto_lock_seconds'];

export interface AiFeatures {
  smartCategories: boolean;
  forecast: boolean;
  scamChecker: boolean;
  assistant: boolean;
  /** Reads ID photos with a vision model, so it stays off until the user opts in. */
  idPrefill: boolean;
}
export type AiFeature = keyof AiFeatures;

export interface Preferences {
  appearance: Appearance;
  language: Language;
  lowDataMode: boolean;
  autoLockSeconds: AutoLockSeconds;
  ai: AiFeatures;
}

export const DEFAULT_PREFERENCES: Preferences = {
  appearance: 'system',
  language: 'en',
  lowDataMode: false,
  autoLockSeconds: 60,
  ai: {
    smartCategories: true,
    forecast: true,
    scamChecker: true,
    assistant: true,
    idPrefill: false,
  },
};

export interface PreferencesState extends Preferences {
  setAppearance: (appearance: Appearance) => void;
  setLanguage: (language: Language) => void;
  setLowDataMode: (on: boolean) => void;
  setAutoLockSeconds: (seconds: AutoLockSeconds) => void;
  setAiFeature: (feature: AiFeature, enabled: boolean) => void;
  /** Adopts the server's copy (after sign-in on a new device). */
  applyServer: (preferences: ApiPreferences) => void;
}

export function fromApiPreferences(api: ApiPreferences): Preferences {
  return {
    appearance: api.appearance,
    language: api.language,
    lowDataMode: api.low_data_mode,
    autoLockSeconds: api.auto_lock_seconds,
    ai: {
      smartCategories: api.ai.smart_categories,
      forecast: api.ai.forecast,
      scamChecker: api.ai.scam_checker,
      assistant: api.ai.assistant,
      idPrefill: api.ai.id_prefill,
    },
  };
}

/** `hide_balances` lives in the privacy store; the caller passes it in. */
export function toApiPreferences(prefs: Preferences, hideBalances: boolean): ApiPreferences {
  return {
    appearance: prefs.appearance,
    language: prefs.language,
    low_data_mode: prefs.lowDataMode,
    auto_lock_seconds: prefs.autoLockSeconds,
    hide_balances: hideBalances,
    ai: {
      smart_categories: prefs.ai.smartCategories,
      forecast: prefs.ai.forecast,
      scam_checker: prefs.ai.scamChecker,
      assistant: prefs.ai.assistant,
      id_prefill: prefs.ai.idPrefill,
    },
  };
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFERENCES,
      setAppearance: (appearance) => set({ appearance }),
      setLanguage: (language) => set({ language }),
      setLowDataMode: (lowDataMode) => set({ lowDataMode }),
      setAutoLockSeconds: (autoLockSeconds) => set({ autoLockSeconds }),
      setAiFeature: (feature, enabled) => set((s) => ({ ai: { ...s.ai, [feature]: enabled } })),
      applyServer: (preferences) => set(fromApiPreferences(preferences)),
    }),
    {
      name: 'nem-preferences',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      // New AI features added later default sensibly instead of reading as undefined.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<Preferences>;
        return { ...current, ...saved, ai: { ...current.ai, ...saved.ai } };
      },
    },
  ),
);
