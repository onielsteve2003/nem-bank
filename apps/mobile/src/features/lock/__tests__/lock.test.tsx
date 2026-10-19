import type { AuthSession, Schema } from '@nem/contracts';
import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { AppState, type AppStateStatus } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components';
import { repositoriesFromDispatcher, RepositoryProvider, type Call } from '@/data';
import { QueryProvider } from '@/lib/query';
import { useLockStore, usePreferencesStore, useSessionStore } from '@/stores';
import { ThemeProvider } from '@/theme';

import { AppLock } from '../AppLock';
import { pinErrorMessage } from '../pinErrors';
import { shouldLock } from '../useAutoLock';

jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));
jest.mock('expo-screen-capture', () => ({
  preventScreenCaptureAsync: jest.fn(async () => undefined),
  allowScreenCaptureAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-local-authentication', () => ({
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2 },
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  supportedAuthenticationTypesAsync: jest.fn(async () => []),
  authenticateAsync: jest.fn(async () => ({ success: false })),
}));

const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const auth = (): AuthSession => ({
  access_token: 'a',
  access_token_expires_at: new Date(Date.now() + 600_000).toISOString(),
  refresh_token: 'r',
  refresh_token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  token_type: 'Bearer',
  user: { id: 'u1', is_demo: true } as AuthSession['user'],
  device: { id: 'd1' } as AuthSession['device'],
});

const verification = (over: Partial<Schema<'PinVerification'>> = {}) => ({
  valid: false,
  attempts_remaining: 4,
  locked_until: null,
  ...over,
});

let calls: Call[];
const repositories = repositoriesFromDispatcher(async (call) => {
  calls.push(call);
  if (call.operationId !== 'verifyPin') return undefined;
  const { pin } = (call.input as { body: { pin: string } }).body;
  return verification({ valid: pin === '2580' });
});

// Every AppState subscriber (the query client's focus tracking too) hears each change.
const appStateListeners = new Set<(state: AppStateStatus) => void>();
const setAppState = (state: AppStateStatus) =>
  act(async () => appStateListeners.forEach((listener) => listener(state)));

async function renderLock() {
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <RepositoryProvider repositories={repositories}>
        <QueryProvider client={new QueryClient()}>
          <ThemeProvider>
            <ToastProvider>
              <AppLock />
            </ToastProvider>
          </ThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </SafeAreaProvider>,
  );
}

const tap = async (...labels: string[]) => {
  for (const name of labels) await fireEvent.press(screen.getByRole('button', { name }));
};

beforeEach(() => {
  calls = [];
  jest.restoreAllMocks();
  appStateListeners.clear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appStateListeners.add(listener);
    return { remove: () => appStateListeners.delete(listener) };
  });
  // A restored session at launch: signed in, and locked.
  useSessionStore.setState({ status: 'restoring', session: null });
  useSessionStore.getState().setSession(auth());
  useLockStore.setState({ locked: true, authenticating: false });
  usePreferencesStore.setState({ autoLockSeconds: 60 });
});

describe('shouldLock', () => {
  it('locks only once the app has been away for the whole auto-lock time', () => {
    expect(shouldLock(null, 100_000, 60)).toBe(false);
    expect(shouldLock(0, 59_999, 60)).toBe(false);
    expect(shouldLock(0, 60_000, 60)).toBe(true);
  });
});

describe('pinErrorMessage', () => {
  it('counts down the tries left', () => {
    expect(pinErrorMessage(verification({ attempts_remaining: 1 }))).toBe('Wrong PIN. 1 try left.');
  });

  it('says how long a lockout lasts', () => {
    const now = Date.parse('2026-10-18T10:00:00Z');
    expect(
      pinErrorMessage(
        verification({ attempts_remaining: 0, locked_until: '2026-10-18T10:29:30Z' }),
        now,
      ),
    ).toBe('Too many wrong tries. Try again in 30 minutes, or sign out.');
  });
});

describe('lock store', () => {
  it('starts a fresh sign-in unlocked but keeps a restored session locked', () => {
    expect(useLockStore.getState().locked).toBe(true);
    useSessionStore.getState().signOut();
    useSessionStore.getState().setSession(auth());
    expect(useLockStore.getState().locked).toBe(false);
  });
});

describe('AppLock', () => {
  it('unlocks with the right PIN, checked by the bank', async () => {
    await renderLock();
    expect(screen.getByText('Enter your PIN. Demo PIN is 2580')).toBeOnTheScreen();
    await tap('1', '1', '1', '1');
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong PIN. 4 tries left.');
    await tap('2', '5', '8', '0');
    expect(useLockStore.getState().locked).toBe(false);
    expect(screen.queryByText('Welcome back')).toBeNull();
    expect(calls.map((c) => c.operationId)).toEqual(['verifyPin', 'verifyPin']);
  });

  it('offers biometrics on arrival and unlocks when they pass', async () => {
    jest.mocked(LocalAuthentication.hasHardwareAsync).mockResolvedValueOnce(true);
    jest.mocked(LocalAuthentication.isEnrolledAsync).mockResolvedValueOnce(true);
    jest.mocked(LocalAuthentication.supportedAuthenticationTypesAsync).mockResolvedValueOnce([2]);
    jest
      .mocked(LocalAuthentication.authenticateAsync)
      .mockResolvedValueOnce({ success: true } as LocalAuthentication.LocalAuthenticationResult);
    await renderLock();
    await act(async () => undefined);
    expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ disableDeviceFallback: true, cancelLabel: 'Use PIN' }),
    );
    expect(useLockStore.getState().locked).toBe(false);
  });

  it('locks after 60 seconds in the background, not before', async () => {
    useLockStore.setState({ locked: false });
    const clock = jest.spyOn(Date, 'now');
    await renderLock();

    clock.mockReturnValue(0);
    await setAppState('background');
    clock.mockReturnValue(30_000);
    await setAppState('active');
    expect(useLockStore.getState().locked).toBe(false);

    await setAppState('background');
    clock.mockReturnValue(95_000);
    await setAppState('active');
    expect(useLockStore.getState().locked).toBe(true);
  });

  it('covers the app while it is out of the foreground', async () => {
    useLockStore.setState({ locked: false });
    await renderLock();
    await setAppState('active');
    expect(screen.queryByTestId('privacy-cover', { includeHiddenElements: true })).toBeNull();
    await setAppState('inactive');
    expect(screen.getByTestId('privacy-cover', { includeHiddenElements: true })).toBeOnTheScreen();
    await setAppState('active');
    expect(screen.queryByTestId('privacy-cover', { includeHiddenElements: true })).toBeNull();
  });

  it('shows nothing when signed out', async () => {
    useSessionStore.getState().signOut();
    useLockStore.setState({ locked: true });
    await renderLock();
    expect(screen.queryByText('Welcome back')).toBeNull();
  });
});
