import { QueryClient } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { repositoriesFromDispatcher, RepositoryProvider, type Dispatcher } from '@/data';
import { deleteDeviceKey, getDeviceKeyInfo } from '@/lib/deviceKey';
import { QueryProvider } from '@/lib/query';
import { useSessionStore } from '@/stores';

import { useDemoSignIn, useRestartDemo } from '../hooks/useSessionActions';

// The hooks only add a device key against the real bank.
const mockEnv = { apiMode: 'http' as 'http' | 'mock', apiUrl: 'https://api.example.test' };
jest.mock('@/lib/env', () => ({
  get env() {
    return mockEnv;
  },
  devToolsEnabled: false,
}));

const NO_GC_TIMERS = {
  defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
};

const demoAuth = {
  access_token: 'a',
  access_token_expires_at: '2099-01-01T00:00:00Z',
  refresh_token: 'r',
  refresh_token_expires_at: '2099-01-01T00:00:00Z',
  token_type: 'Bearer',
  user: { id: 'u1', is_demo: true, nemtag: 'tolu_1234' },
  device: { id: 'device-from-bank', cool_off_until: null },
};

type Call = Parameters<Dispatcher>[0];
let calls: Call[] = [];
let me: { first_name: string } | Error = { first_name: 'Tolulope' };

const dispatch: Dispatcher = async (call) => {
  calls.push(call);
  if (call.operationId === 'getMe') {
    if (me instanceof Error) throw me;
    return me;
  }
  return call.operationId === 'startDemoSession' ? demoAuth : undefined;
};

function wrapper({ children }: { children: ReactNode }) {
  return (
    <RepositoryProvider repositories={repositoriesFromDispatcher(dispatch)}>
      <QueryProvider client={new QueryClient(NO_GC_TIMERS)}>{children}</QueryProvider>
    </RepositoryProvider>
  );
}

const demoCalls = () => calls.filter((c) => c.operationId === 'startDemoSession');

beforeEach(async () => {
  calls = [];
  me = { first_name: 'Tolulope' };
  mockEnv.apiMode = 'http';
  useSessionStore.setState({ status: 'signedOut', session: null });
  await deleteDeviceKey();
});

describe('demo sign-in', () => {
  it('sends this phone’s device key to the real bank and remembers the device it binds', async () => {
    const { result } = await renderHook(() => useDemoSignIn(), { wrapper });
    await act(async () => result.current.start('tolu'));
    await waitFor(() => expect(useSessionStore.getState().status).toBe('signedIn'));

    const body = (demoCalls()[0]?.input as { body: Record<string, unknown> }).body;
    expect(body.persona).toBe('tolu');
    expect(body.device).toMatchObject({ public_key: expect.stringMatching(/^[\w-]{43}$/) });
    expect((await getDeviceKeyInfo())?.deviceId).toBe('device-from-bank');
  });

  it('sends no device to the offline demo, which has none to bind', async () => {
    mockEnv.apiMode = 'mock';
    const { result } = await renderHook(() => useDemoSignIn(), { wrapper });
    await act(async () => result.current.start('tolu'));
    await waitFor(() => expect(useSessionStore.getState().status).toBe('signedIn'));

    expect(demoCalls()[0]?.input).toEqual({ body: { persona: 'tolu' } });
    expect(await getDeviceKeyInfo()).toBeNull();
  });
});

describe('restarting the demo', () => {
  it('starts a fresh customer with the same persona and swaps the session', async () => {
    me = { first_name: 'Emeka' };
    const { result } = await renderHook(() => useRestartDemo(), { wrapper });
    await act(async () => result.current());

    expect((demoCalls()[0]?.input as { body: { persona: string } }).body.persona).toBe('emeka');
    expect(useSessionStore.getState().session?.deviceId).toBe('device-from-bank');
  });

  it('falls back to Tolu when the persona cannot be read', async () => {
    me = new Error('offline');
    const { result } = await renderHook(() => useRestartDemo(), { wrapper });
    await act(async () => result.current());

    expect((demoCalls()[0]?.input as { body: { persona: string } }).body.persona).toBe('tolu');
  });
});
