import type { AuthSession } from '@nem/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useState, type ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Screen, ScreenBannerProvider, Text, ToastProvider } from '@/components';
import { problem } from '@/data';
import { AppErrorBoundary } from '@/features/shell/CrashScreen';
import { OfflineBanner } from '@/features/shell/OfflineBanner';
import { useSessionWatcher } from '@/features/shell/useSessionWatcher';
import { createQueryClient, isSessionEnded } from '@/lib/query';
import { useNetworkStore, useSessionStore } from '@/stores';
import { ThemeProvider } from '@/theme';

jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const session = (refreshInMs = 30 * 86_400_000): AuthSession => ({
  access_token: 'a',
  access_token_expires_at: new Date(Date.now() + 600_000).toISOString(),
  refresh_token: 'r',
  refresh_token_expires_at: new Date(Date.now() + refreshInMs).toISOString(),
  token_type: 'Bearer',
  user: { id: 'u', is_demo: true } as AuthSession['user'],
  device: { id: 'd' } as AuthSession['device'],
});

function Shell({ children, client }: { children: ReactNode; client?: QueryClient }) {
  const [queryClient] = useState(() => client ?? new QueryClient());
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider initialPreference="dark">
          <ToastProvider>{children}</ToastProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

beforeEach(() => {
  useNetworkStore.setState({ deviceOnline: true, simulatedOffline: false });
  useSessionStore.setState({ status: 'signedOut', session: null, endedBy: null });
});

describe('offline banner', () => {
  const renderScreen = () =>
    render(
      <Shell>
        <ScreenBannerProvider value={<OfflineBanner />}>
          <Screen>
            <Text>Balance</Text>
          </Screen>
        </ScreenBannerProvider>
      </Shell>,
    );

  it('stays hidden while online', async () => {
    await renderScreen();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says the phone is offline and that payments need a connection', async () => {
    await renderScreen();
    await act(async () => useNetworkStore.getState().setDeviceOnline(false));
    const alert = screen.getByRole('alert');
    expect(alert.props.accessibilityLabel).toMatch(/^You’re offline\. Showing what was saved at/);
    expect(alert.props.accessibilityLabel).toMatch(/Payments need a connection\.$/);
  });

  it('names Demo Controls when the outage is simulated', async () => {
    await renderScreen();
    await act(async () => useNetworkStore.getState().setSimulatedOffline(true));
    expect(screen.getByText('Demo Controls has the bank offline')).toBeOnTheScreen();
  });
});

describe('network store', () => {
  it('stamps the time the connection was lost, not later updates', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    useNetworkStore.getState().setDeviceOnline(false);
    jest.spyOn(Date, 'now').mockReturnValue(9_000);
    useNetworkStore.getState().setSimulatedOffline(true);
    expect(useNetworkStore.getState().lastOnlineAt).toBe(1_000);
    jest.restoreAllMocks();
  });
});

describe('error boundary', () => {
  function Bomb({ explode }: { explode: { current: boolean } }) {
    if (explode.current) throw new Error('boom');
    return <Text>Recovered</Text>;
  }

  it('shows the crash screen instead of a blank app, and recovers on retry', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const explode = { current: true };
    await render(
      <Shell>
        <AppErrorBoundary>
          <Bomb explode={explode} />
        </AppErrorBoundary>
      </Shell>,
    );
    expect(screen.getByText('This screen hit a problem')).toBeOnTheScreen();
    expect(screen.getByText(/Your money is safe/)).toBeOnTheScreen();

    explode.current = false;
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Recovered')).toBeOnTheScreen();
    jest.restoreAllMocks();
  });
});

describe('session expiry', () => {
  function Watcher() {
    useSessionWatcher();
    return null;
  }

  it('only treats session-ending 401s as expiry', () => {
    expect(isSessionEnded(problem(401, 'invalid_token', 'Ended'))).toBe(true);
    expect(isSessionEnded(problem(401, 'invalid_credentials', 'Wrong password'))).toBe(false);
    expect(isSessionEnded(problem(503, 'offline', 'Offline'))).toBe(false);
  });

  it('signs out when any query finds the session over', async () => {
    useSessionStore.getState().setSession(session());
    const client = createQueryClient();
    await client
      .fetchQuery({
        queryKey: ['accounts', 'list'],
        queryFn: () => Promise.reject(problem(401, 'invalid_token', 'Ended')),
        retry: false,
      })
      .catch(() => undefined);
    expect(useSessionStore.getState()).toMatchObject({ status: 'signedOut', endedBy: 'expired' });
  });

  it('does not count a user sign-out as expiry', () => {
    useSessionStore.getState().setSession(session());
    useSessionStore.getState().signOut();
    useSessionStore.getState().expire();
    expect(useSessionStore.getState().endedBy).toBe('signedOut');
  });

  it('expires when the refresh token runs out, wipes the cache and says why', async () => {
    jest.useFakeTimers();
    const client = new QueryClient();
    client.setQueryData(['accounts', 'list'], ['balance']);
    useSessionStore.getState().setSession(session(5_000));
    await render(
      <Shell client={client}>
        <Watcher />
      </Shell>,
    );
    await act(async () => jest.advanceTimersByTime(5_001));
    expect(useSessionStore.getState()).toMatchObject({ status: 'signedOut', endedBy: 'expired' });
    expect(client.getQueryData(['accounts', 'list'])).toBeUndefined();
    expect(screen.getByText('Your session ended. Sign in again to continue.')).toBeOnTheScreen();
    jest.useRealTimers();
  });
});
