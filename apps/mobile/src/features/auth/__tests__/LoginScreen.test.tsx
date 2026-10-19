import * as ed from '@noble/ed25519';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { problem, repositoriesFromDispatcher, RepositoryProvider, type Dispatcher } from '@/data';
import { getBiometrics } from '@/lib/biometrics';
import {
  createDeviceKey,
  deleteDeviceKey,
  fromBase64Url,
  getDeviceKeyInfo,
  setDeviceId,
} from '@/lib/deviceKey';
import { QueryProvider } from '@/lib/query';
import { useSessionStore } from '@/stores';
import { ThemeProvider } from '@/theme';

import { CoolOffBanner } from '../components/CoolOffBanner';
import { toLoginIdentifier } from '../loginForm';
import { LoginScreen } from '../screens/LoginScreen';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));
jest.mock('@/lib/biometrics', () => ({
  NO_BIOMETRICS: { available: false, label: '' },
  getBiometrics: jest.fn(),
  authenticateWithBiometrics: jest.fn(),
}));

const NO_GC_TIMERS = {
  defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
};
const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const IN_A_DAY = new Date(Date.now() + 86_400_000).toISOString();

function sessionFor(deviceId: string, coolOffUntil: string | null = null) {
  return {
    access_token: 'a',
    access_token_expires_at: '2099-01-01T00:00:00Z',
    refresh_token: 'r',
    refresh_token_expires_at: '2099-01-01T00:00:00Z',
    token_type: 'Bearer',
    user: { id: 'u1', is_demo: false },
    device: { id: deviceId, cool_off_until: coolOffUntil },
  };
}

type Call = Parameters<Dispatcher>[0];

async function renderWith(ui: React.ReactElement, dispatch: Dispatcher = jest.fn()) {
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <RepositoryProvider repositories={repositoriesFromDispatcher(dispatch)}>
        <QueryProvider client={new QueryClient(NO_GC_TIMERS)}>
          <ThemeProvider initialPreference="dark">{ui}</ThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </SafeAreaProvider>,
  );
}

async function fillAndSubmit(identifier: string, password: string) {
  await fireEvent.changeText(screen.getByLabelText('Email or phone number'), identifier);
  await fireEvent.changeText(screen.getByLabelText('Password'), password);
  await fireEvent.press(screen.getByRole('button', { name: 'Log in' }));
}

beforeEach(async () => {
  jest.clearAllMocks();
  useSessionStore.setState({ status: 'signedOut', session: null });
  await deleteDeviceKey();
  jest.mocked(getBiometrics).mockResolvedValue({ available: false, label: '' });
});

describe('toLoginIdentifier', () => {
  it.each([
    ['  Tolu.Demo@Example.com ', 'tolu.demo@example.com'],
    ['0803 123 4567', '+2348031234567'],
    ['+234 803 123 4567', '+2348031234567'],
    ['tolu@', null],
    ['12345', null],
  ])('%j → %j', (input, expected) => {
    expect(toLoginIdentifier(input)).toBe(expected);
  });
});

it('binds a new device on password login and starts the cool-off notice', async () => {
  const dispatch = jest.fn(async (_call: Call) => sessionFor('device-9', IN_A_DAY));
  await renderWith(<LoginScreen />, dispatch);

  await fillAndSubmit('0803 123 4567', 'Kitchen-Mango-River-7');

  await waitFor(() => expect(useSessionStore.getState().status).toBe('signedIn'));
  const key = await getDeviceKeyInfo();
  expect(key).toMatchObject({ biometric: false, deviceId: 'device-9' });
  const body = (dispatch.mock.calls[0]![0].input as { body: Record<string, unknown> }).body;
  expect(body).toMatchObject({
    identifier: '+2348031234567',
    password: 'Kitchen-Mango-River-7',
    device: expect.objectContaining({ public_key: key!.publicKey }),
  });
  expect(body).not.toHaveProperty('device_id');
  expect(useSessionStore.getState().session).toMatchObject({
    newDeviceNotice: true,
    coolOffUntil: IN_A_DAY,
  });
});

it('a device the bank knows sends its ID and skips the notice', async () => {
  await createDeviceKey({ biometric: false });
  await setDeviceId('device-1');
  const dispatch = jest.fn(async (_call: Call) => sessionFor('device-1'));
  await renderWith(<LoginScreen />, dispatch);

  await fillAndSubmit('tolu.demo@example.com', 'Demo1234!');

  await waitFor(() => expect(useSessionStore.getState().status).toBe('signedIn'));
  expect(dispatch.mock.calls[0]![0].input).toMatchObject({ body: { device_id: 'device-1' } });
  expect(useSessionStore.getState().session?.newDeviceNotice).toBe(false);
});

it('says the details are wrong without saying which', async () => {
  await renderWith(<LoginScreen />, async () => {
    throw problem(401, 'invalid_credentials', 'Email or password is not right');
  });
  await fillAndSubmit('tolu.demo@example.com', 'nope');
  expect(
    await screen.findByText('That email, phone number or password is not right.'),
  ).toBeOnTheScreen();
  expect(useSessionStore.getState().status).toBe('signedOut');
});

it('checks the form before calling the bank', async () => {
  const dispatch = jest.fn();
  await renderWith(<LoginScreen />, dispatch);
  await fillAndSubmit('not an email', '');
  expect(await screen.findByText('Enter your email or a Nigerian mobile number')).toBeOnTheScreen();
  expect(screen.getByText('Enter your password')).toBeOnTheScreen();
  expect(dispatch).not.toHaveBeenCalled();
});

it('Face ID quick login signs the bank nonce with the device key', async () => {
  const key = await createDeviceKey({ biometric: true });
  await setDeviceId('device-1');
  jest.mocked(getBiometrics).mockResolvedValue({ available: true, label: 'Face ID' });
  const dispatch = jest.fn(async ({ method }: Call) =>
    method === 'createDeviceChallenge'
      ? { challenge_id: 'c1', nonce: 'nonce-1', expires_at: IN_A_DAY }
      : sessionFor('device-1'),
  );
  await renderWith(<LoginScreen />, dispatch);

  // Offered on arrival, without a tap.
  await waitFor(() => expect(useSessionStore.getState().status).toBe('signedIn'));
  expect(screen.getByRole('button', { name: 'Log in with Face ID' })).toBeOnTheScreen();
  const login = dispatch.mock.calls.find(([c]) => c.method === 'loginWithDevice')![0];
  const { signature } = (login.input as { body: { signature: string } }).body;
  expect(
    ed.verify(fromBase64Url(signature), utf8ToBytes('nonce-1'), fromBase64Url(key.publicKey)),
  ).toBe(true);
});

it('does not offer Face ID when the key was kept PIN-only', async () => {
  await createDeviceKey({ biometric: false });
  await setDeviceId('device-1');
  jest.mocked(getBiometrics).mockResolvedValue({ available: true, label: 'Face ID' });
  await renderWith(<LoginScreen />);
  await screen.findByText('Welcome back');
  expect(screen.queryByRole('button', { name: 'Log in with Face ID' })).toBeNull();
});

it('the cool-off banner shows until the cool-off ends', async () => {
  useSessionStore.getState().setSession(sessionFor('device-9', IN_A_DAY) as never);
  await renderWith(<CoolOffBanner />);
  expect(screen.getByText('New device: lower limits')).toBeOnTheScreen();

  useSessionStore.getState().setSession(sessionFor('device-9', '2020-01-01T00:00:00Z') as never);
  await waitFor(() => expect(screen.queryByText('New device: lower limits')).toBeNull());
});
