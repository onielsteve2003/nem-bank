import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { BankWakingOverlay } from '@/features/shell/BankWakingOverlay';
import { useBankWarmup } from '@/features/shell/useBankWarmup';
import { useBankStore, useSessionStore } from '@/stores';
import { ThemeProvider } from '@/theme';

jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

beforeEach(() => {
  useBankStore.setState({ status: 'idle', demoFallback: false, lastOkAt: null, round: 0 });
  useSessionStore.setState({ status: 'signedOut', session: null, endedBy: null });
});

function Providers({ children, client }: { children: ReactNode; client?: QueryClient }) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={client ?? new QueryClient()}>
        <ThemeProvider initialPreference="dark">{children}</ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const HTTP = { apiMode: 'http', apiUrl: 'https://api.test' } as const;

describe('cold-start overlay', () => {
  it('is not shown while the bank is awake or being checked', async () => {
    useBankStore.setState({ status: 'checking' });
    await render(<BankWakingOverlay />, { wrapper: Providers });
    expect(screen.queryByTestId('bank-waking')).toBeNull();
  });

  it('says the bank is waking, and offers the demo bank only after a wait', async () => {
    jest.useFakeTimers();
    useBankStore.setState({ status: 'waking' });
    await render(<BankWakingOverlay />, { wrapper: Providers });
    expect(screen.getByText('Waking up the bank…')).toBeOnTheScreen();
    expect(screen.queryByText('Use the demo bank instead')).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(15_000);
    });
    expect(screen.getByText('Use the demo bank instead')).toBeOnTheScreen();
    jest.useRealTimers();
  });

  it('falls back to the demo bank and ends the real session', async () => {
    useBankStore.setState({ status: 'unreachable' });
    useSessionStore.setState({
      status: 'signedIn',
      session: { userId: 'u' } as never,
      endedBy: null,
    });
    await render(<BankWakingOverlay />, { wrapper: Providers });
    expect(screen.getByText('We can’t reach the bank')).toBeOnTheScreen();

    await fireEvent.press(screen.getByText('Use the demo bank instead'));
    expect(useBankStore.getState().demoFallback).toBe(true);
    expect(useBankStore.getState().status).toBe('idle');
    expect(useSessionStore.getState().status).toBe('signedOut');
    expect(screen.queryByTestId('bank-waking')).toBeNull();
  });

  it('tries again on request', async () => {
    useBankStore.setState({ status: 'unreachable', round: 3 });
    await render(<BankWakingOverlay />, { wrapper: Providers });
    await fireEvent.press(screen.getByText('Try again'));
    expect(useBankStore.getState().round).toBe(4);
  });
});

describe('useBankWarmup', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const answer = (code = 200) => {
    const fetch = jest.fn(() => Promise.resolve(new Response('{}', { status: code })));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    return fetch;
  };

  it('does nothing on the mock bank', async () => {
    const fetch = answer();
    await renderHook(() => useBankWarmup({ apiMode: 'mock', apiUrl: undefined }), {
      wrapper: Providers,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(useBankStore.getState().status).toBe('idle');
  });

  it('marks the bank ready when it answers, and refetches nothing if it never slept', async () => {
    const fetch = answer();
    const client = new QueryClient();
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    await renderHook(() => useBankWarmup(HTTP), {
      wrapper: ({ children }) => <Providers client={client}>{children}</Providers>,
    });
    await waitFor(() => expect(useBankStore.getState().status).toBe('ready'));
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe('https://api.test/readyz');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('refetches everything once a bank that was waking answers', async () => {
    answer();
    useBankStore.setState({ status: 'waking' });
    const client = new QueryClient();
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    await renderHook(() => useBankWarmup(HTTP), {
      wrapper: ({ children }) => <Providers client={client}>{children}</Providers>,
    });
    await waitFor(() => expect(useBankStore.getState().status).toBe('ready'));
    expect(invalidate).toHaveBeenCalled();
  });

  it('stays out of the way once the person has chosen the demo bank', async () => {
    const fetch = answer();
    useBankStore.setState({ demoFallback: true });
    await renderHook(() => useBankWarmup(HTTP), { wrapper: Providers });
    expect(fetch).not.toHaveBeenCalled();
  });
});
