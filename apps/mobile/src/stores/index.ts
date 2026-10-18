import { useEffect, useState } from 'react';

import { useDemoStore } from './demo';
import { usePreferencesStore } from './preferences';
import { usePrivacyStore } from './privacy';
import { useSessionStore } from './session';

export { bindSimulation, useDemoStore, type DemoState } from './demo';
export { useDeepLinkStore, type DeepLinkState } from './deepLink';
export { useAppLocked, useLockStore, type LockState } from './lock';
export { isOnline, useIsOnline, useNetworkStore, type NetworkState } from './network';
export {
  DEFAULT_PREFERENCES,
  fromApiPreferences,
  toApiPreferences,
  usePreferencesStore,
  type AiFeature,
  type AiFeatures,
  type ApiPreferences,
  type Appearance,
  type AutoLockSeconds,
  type Language,
  type Preferences,
  type PreferencesState,
} from './preferences';
export { useBalancesHidden, usePrivacyStore, type PrivacyState } from './privacy';
export {
  ACCESS_TOKEN_SKEW_MS,
  canRefresh,
  isAccessTokenFresh,
  toStoredSession,
  useSessionStore,
  type SessionEnd,
  type SessionState,
  type SessionStatus,
  type StoredSession,
} from './session';

const PERSISTED = [useSessionStore, usePreferencesStore, usePrivacyStore, useDemoStore] as const;

const allHydrated = () => PERSISTED.every((store) => store.persist.hasHydrated());

/**
 * True once every persisted store has been read from disk. The root layout keeps
 * the splash up until then, so the first frame already has the right theme.
 */
export function useStoresHydrated(): boolean {
  const [hydrated, setHydrated] = useState(allHydrated);
  useEffect(() => {
    if (hydrated) return;
    const update = () => setHydrated(allHydrated());
    const unsubscribes = PERSISTED.map((store) => store.persist.onFinishHydration(update));
    update();
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [hydrated]);
  return hydrated;
}
