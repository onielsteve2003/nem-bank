import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories, DEMO_OTP } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { ResetPinFlow } from '../components/ResetPinFlow';
import { ForgotPasswordScreen } from '../screens/ForgotPasswordScreen';

const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: mockBack, canGoBack: () => true }),
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

const NO_GC_TIMERS = {
  defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
};
const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

let repos: Repositories;

async function renderWith(ui: React.ReactElement) {
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <RepositoryProvider repositories={repos}>
        <QueryProvider client={new QueryClient(NO_GC_TIMERS)}>
          <ThemeProvider initialPreference="dark">
            <ToastProvider>{ui}</ToastProvider>
          </ThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </SafeAreaProvider>,
  );
}

async function typePin(pin: string) {
  for (const digit of pin) await fireEvent.press(screen.getByRole('button', { name: digit }));
}

const codeField = () => screen.getByLabelText('Verification code, 6 digits');

beforeEach(() => {
  jest.clearAllMocks();
  repos = createMockRepositories({ store: createMemoryStore(), simulation: { latency: 'off' } });
});

describe('ForgotPasswordScreen', () => {
  it('emails a code, refuses a weak password, then sets a strong one', async () => {
    await renderWith(<ForgotPasswordScreen />);
    await fireEvent.changeText(screen.getByLabelText('Email'), 'Tolu.Demo@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'Send code' }));

    expect(await screen.findByText('Choose a new password')).toBeOnTheScreen();
    await fireEvent.changeText(codeField(), DEMO_OTP);
    await fireEvent.changeText(screen.getByLabelText('New password'), 'password123');
    await fireEvent.press(screen.getByRole('button', { name: 'Save new password' }));
    expect(mockBack).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByLabelText('New password'), 'Kitchen-Mango-River-7');
    await fireEvent.press(screen.getByRole('button', { name: 'Save new password' }));

    await waitFor(() => expect(mockBack).toHaveBeenCalled());
    await expect(
      repos.auth.login({
        body: {
          identifier: 'tolu.demo@example.com',
          password: 'Kitchen-Mango-River-7',
          device: { name: 'iPhone', platform: 'ios', public_key: 'cHVibGlj' },
        },
      }),
    ).resolves.toMatchObject({ token_type: 'Bearer' });
  });

  it('checks the email before asking the bank', async () => {
    const spy = jest.fn(repos.auth.forgotPassword);
    repos = { ...repos, auth: { ...repos.auth, forgotPassword: spy } };
    await renderWith(<ForgotPasswordScreen />);
    await fireEvent.changeText(screen.getByLabelText('Email'), 'tolu@');
    await fireEvent.press(screen.getByRole('button', { name: 'Send code' }));
    expect(screen.getByText('Enter a valid email address')).toBeOnTheScreen();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('ResetPinFlow', () => {
  beforeAll(() => configure({ defaultIncludeHiddenElements: true }));

  it('steps up with the email code, refuses a weak PIN and saves the new one', async () => {
    const onDone = jest.fn();
    await renderWith(<ResetPinFlow onDone={onDone} onCancel={jest.fn()} />);

    await fireEvent.press(screen.getByRole('button', { name: 'Email me a code' }));
    await fireEvent.changeText(
      await screen.findByLabelText('Verification code, 6 digits'),
      '000000',
    );
    expect(await screen.findByText(/That code is not right\. 4 attempts left/)).toBeOnTheScreen();

    await fireEvent.changeText(codeField(), DEMO_OTP);
    expect(await screen.findByText('Choose a new PIN')).toBeOnTheScreen();

    await typePin('1234');
    expect(await screen.findByText(/Too easy to guess/)).toBeOnTheScreen();
    await typePin('4826');
    expect(await screen.findByText('Confirm your new PIN')).toBeOnTheScreen();
    await typePin('4826');

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect((await repos.users.verifyPin({ body: { pin: '4826' } })).valid).toBe(true);
  });

  it('a mismatched confirmation starts the choice again', async () => {
    await renderWith(<ResetPinFlow onDone={jest.fn()} onCancel={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Email me a code' }));
    await fireEvent.changeText(
      await screen.findByLabelText('Verification code, 6 digits'),
      DEMO_OTP,
    );
    await screen.findByText('Choose a new PIN');
    await typePin('4826');
    await screen.findByText('Confirm your new PIN');
    await typePin('4827');
    expect(await screen.findByText(/didn't match/)).toBeOnTheScreen();
    expect(screen.getByText('Choose a new PIN')).toBeOnTheScreen();
  });
});
