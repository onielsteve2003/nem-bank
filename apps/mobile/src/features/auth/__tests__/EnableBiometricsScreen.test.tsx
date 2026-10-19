import { QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { problem, repositoriesFromDispatcher, RepositoryProvider, type Dispatcher } from '@/data';
import { authenticateWithBiometrics, getBiometrics } from '@/lib/biometrics';
import { deleteDeviceKey, getDeviceKeyInfo } from '@/lib/deviceKey';
import { QueryProvider } from '@/lib/query';
import { useSessionStore } from '@/stores';
import { ThemeProvider } from '@/theme';

import { deviceName, EnableBiometricsScreen } from '../screens/EnableBiometricsScreen';
import { useSignupStore } from '../signupStore';

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
  Redirect: () => null,
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));
jest.mock('@/lib/biometrics', () => ({
  NO_BIOMETRICS: { available: false, label: '' },
  getBiometrics: jest.fn(),
  authenticateWithBiometrics: jest.fn(),
}));

const FACE_ID = { available: true, label: 'Face ID' };
const NO_GC_TIMERS = {
  defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
};
const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const SESSION = {
  access_token: 'a',
  access_token_expires_at: '2099-01-01T00:00:00Z',
  refresh_token: 'r',
  refresh_token_expires_at: '2099-01-01T00:00:00Z',
  token_type: 'Bearer',
  user: { id: 'u1', is_demo: false },
  device: { id: 'device-1' },
};

function readySignup() {
  const store = useSignupStore.getState();
  store.start(
    {
      signup_id: 's1',
      otp: {
        challenge_id: 's1',
        channel: 'email',
        destination_masked: 'a*a@example.com',
        expires_at: '2026-10-19T12:10:00Z',
        resend_available_at: '2026-10-19T12:01:00Z',
        attempts_remaining: 5,
      },
    },
    {
      first_name: 'Ada',
      last_name: 'Obi',
      email: 'ada@example.com',
      phone: '+2348031234567',
      date_of_birth: '1994-03-05',
      consent: {
        terms_version: '2026-10',
        privacy_version: '2026-10',
        accepted_at: '2026-10-19T12:00:00Z',
      },
    },
  );
  store.verified('verified_s1');
  store.setPassword('Kitchen-Mango-River-7');
  store.setPin('2580');
}

async function renderScreen(dispatch: Dispatcher) {
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <RepositoryProvider repositories={repositoriesFromDispatcher(dispatch)}>
        <QueryProvider client={new QueryClient(NO_GC_TIMERS)}>
          <ThemeProvider initialPreference="dark">
            <EnableBiometricsScreen />
          </ThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(async () => {
  jest.clearAllMocks();
  readySignup();
  useSessionStore.setState({ status: 'signedOut', session: null });
  await deleteDeviceKey();
  jest.mocked(getBiometrics).mockResolvedValue(FACE_ID);
  jest.mocked(authenticateWithBiometrics).mockResolvedValue(true);
});

it('names the device after its owner', () => {
  expect(deviceName('Ada')).toMatch(/^Ada's (iPhone|phone|browser)$/);
});

it('turns on Face ID, registers the device key with the account and signs in', async () => {
  const dispatch = jest.fn<ReturnType<Dispatcher>, Parameters<Dispatcher>>(async () => SESSION);
  await renderScreen(dispatch);

  await fireEvent.press(await screen.findByRole('button', { name: 'Turn on Face ID' }));

  await waitFor(() => expect(useSessionStore.getState().status).toBe('signedIn'));
  const key = await getDeviceKeyInfo();
  expect(key).toMatchObject({ biometric: true, deviceId: 'device-1' });
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      method: 'completeSignup',
      input: {
        body: expect.objectContaining({
          signup_id: 's1',
          verification_token: 'verified_s1',
          password: 'Kitchen-Mango-River-7',
          pin: '2580',
          device: expect.objectContaining({ public_key: key!.publicKey, hardware_backed: true }),
        }),
      },
    }),
  );
  expect(useSignupStore.getState().pending).toBeNull();
});

it('creates nothing when the face scan fails', async () => {
  jest.mocked(authenticateWithBiometrics).mockResolvedValue(false);
  const dispatch = jest.fn<ReturnType<Dispatcher>, Parameters<Dispatcher>>();
  await renderScreen(dispatch);

  await fireEvent.press(await screen.findByRole('button', { name: 'Turn on Face ID' }));

  expect(await screen.findByText(/Face ID wasn't confirmed/)).toBeOnTheScreen();
  expect(dispatch).not.toHaveBeenCalled();
  expect(await getDeviceKeyInfo()).toBeNull();
});

it('"Not now" keeps the key PIN-only; a refused PIN sends the user back', async () => {
  await renderScreen(async () => {
    throw problem(422, 'weak_pin', 'Pick a PIN that is harder to guess');
  });
  await fireEvent.press(await screen.findByRole('button', { name: 'Not now' }));

  expect(
    await screen.findByText('Pick a PIN that is harder to guess. Go back and change it.'),
  ).toBeOnTheScreen();
  expect(authenticateWithBiometrics).not.toHaveBeenCalled();
  expect(await getDeviceKeyInfo()).toMatchObject({ biometric: false });
  expect(useSessionStore.getState().status).toBe('signedOut');
});

it('offers the PIN only where there is no biometric hardware', async () => {
  jest.mocked(getBiometrics).mockResolvedValue({ available: false, label: '' });
  await renderScreen(async () => SESSION);
  expect(await screen.findByText('Finish setting up')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Open my account' }));
  await waitFor(() => expect(useSessionStore.getState().status).toBe('signedIn'));
});
