import type { AuthSession } from '@nem/contracts';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { createSimulation, DEFAULT_SIMULATION } from '@/data/mock/simulation';

import {
  bindSimulation,
  canRefresh,
  DEFAULT_PREFERENCES,
  fromApiPreferences,
  isAccessTokenFresh,
  toApiPreferences,
  useDemoStore,
  usePreferencesStore,
  usePrivacyStore,
  useSessionStore,
} from '..';

const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function authSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    access_token: 'access-1',
    access_token_expires_at: iso(10 * 60_000),
    refresh_token: 'refresh-1',
    refresh_token_expires_at: iso(30 * 24 * 3_600_000),
    token_type: 'Bearer',
    user: { id: 'user-1', is_demo: true } as AuthSession['user'],
    device: { id: 'device-1' } as AuthSession['device'],
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('session store', () => {
  beforeEach(() => useSessionStore.setState({ status: 'signedOut', session: null }));

  it('stores tokens in SecureStore, never AsyncStorage', async () => {
    useSessionStore.getState().setSession(authSession());
    await flush();
    const state = useSessionStore.getState();
    expect(state.status).toBe('signedIn');
    expect(state.session).toMatchObject({ userId: 'user-1', deviceId: 'device-1', isDemo: true });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      'nem.session',
      expect.stringContaining('refresh-1'),
    );
    const keys = await AsyncStorage.getAllKeys();
    for (const key of keys) expect(await AsyncStorage.getItem(key)).not.toContain('refresh-1');
  });

  it('restores a live session and drops one whose refresh token expired', async () => {
    useSessionStore.getState().setSession(authSession());
    await flush();
    useSessionStore.setState({ status: 'restoring' });
    await useSessionStore.persist.rehydrate();
    expect(useSessionStore.getState().status).toBe('signedIn');

    useSessionStore.getState().setSession(authSession({ refresh_token_expires_at: iso(-1) }));
    await flush();
    await useSessionStore.persist.rehydrate();
    expect(useSessionStore.getState()).toMatchObject({ status: 'signedOut', session: null });
  });

  it('signs out and forgets the tokens', async () => {
    useSessionStore.getState().setSession(authSession());
    useSessionStore.getState().signOut();
    await flush();
    expect(useSessionStore.getState().session).toBeNull();
    expect(await SecureStore.getItemAsync('nem.session')).not.toContain('refresh-1');
  });

  it('treats an access token as stale 30 s before it expires', () => {
    useSessionStore.getState().setSession(authSession({ access_token_expires_at: iso(29_000) }));
    const session = useSessionStore.getState().session!;
    expect(isAccessTokenFresh(session, NOW)).toBe(false);
    expect(isAccessTokenFresh(session, NOW - 60_000)).toBe(true);
    expect(canRefresh(session, NOW)).toBe(true);
  });
});

describe('preferences store', () => {
  beforeEach(() => usePreferencesStore.setState(DEFAULT_PREFERENCES));

  it('starts with safe defaults: system theme, 60 s lock, ID prefill off', () => {
    const s = usePreferencesStore.getState();
    expect(s).toMatchObject({ appearance: 'system', language: 'en', autoLockSeconds: 60 });
    expect(s.ai.idPrefill).toBe(false);
    expect(s.ai.scamChecker).toBe(true);
  });

  it('switches one AI feature without touching the others', () => {
    usePreferencesStore.getState().setAiFeature('assistant', false);
    expect(usePreferencesStore.getState().ai).toEqual({
      ...DEFAULT_PREFERENCES.ai,
      assistant: false,
    });
  });

  it('round-trips the API shape', () => {
    const api = toApiPreferences({ ...DEFAULT_PREFERENCES, language: 'pcm' }, true);
    expect(api).toMatchObject({ language: 'pcm', hide_balances: true, auto_lock_seconds: 60 });
    expect(api.ai.id_prefill).toBe(false);
    expect(fromApiPreferences(api)).toEqual({ ...DEFAULT_PREFERENCES, language: 'pcm' });
  });

  it('fills AI features missing from an older saved copy', async () => {
    await AsyncStorage.setItem(
      'nem-preferences',
      JSON.stringify({ state: { appearance: 'light', ai: { assistant: false } }, version: 1 }),
    );
    await usePreferencesStore.persist.rehydrate();
    const s = usePreferencesStore.getState();
    expect(s.appearance).toBe('light');
    expect(s.ai).toEqual({ ...DEFAULT_PREFERENCES.ai, assistant: false });
  });
});

describe('privacy store', () => {
  it('toggles hidden balances and persists the choice', async () => {
    usePrivacyStore.setState({ balancesHidden: false });
    usePrivacyStore.getState().toggleBalances();
    await flush();
    expect(usePrivacyStore.getState().balancesHidden).toBe(true);
    expect(await AsyncStorage.getItem('nem-privacy')).toContain('"balancesHidden":true');
  });
});

describe('demo store', () => {
  beforeEach(() => useDemoStore.getState().resetSimulation());

  it('clamps the error rate to 0..1', () => {
    useDemoStore.getState().setSimulation({ errorRate: 4 });
    expect(useDemoStore.getState().simulation.errorRate).toBe(1);
    useDemoStore.getState().setSimulation({ errorRate: Number.NaN });
    expect(useDemoStore.getState().simulation.errorRate).toBe(0);
  });

  it('pushes saved and changed settings into the mock bank', () => {
    useDemoStore.getState().setSimulation({ latency: 'slow' });
    const simulation = createSimulation();
    const unbind = bindSimulation(simulation);
    expect(simulation.get().latency).toBe('slow');

    useDemoStore.getState().setSimulation({ offline: true });
    expect(simulation.get().offline).toBe(true);

    unbind();
    useDemoStore.getState().resetSimulation();
    expect(simulation.get().offline).toBe(true);
    expect(useDemoStore.getState().simulation).toEqual(DEFAULT_SIMULATION);
  });
});
