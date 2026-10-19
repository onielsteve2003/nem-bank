import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { problem, repositoriesFromDispatcher, RepositoryProvider, type Dispatcher } from '@/data';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { formatCountdown, otpErrorMessage, VerifyEmailScreen } from '../screens/VerifyEmailScreen';
import { useSignupStore } from '../signupStore';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  Redirect: () => null,
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

// The BottomSheet mock renders the closed SMS notice inline as a modal, hiding its siblings.
configure({ defaultIncludeHiddenElements: true });

const NO_GC_TIMERS = {
  defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
};
const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();

const OTP = {
  challenge_id: 's1',
  channel: 'email' as const,
  destination_masked: 'a*a@example.com',
  expires_at: inSeconds(600),
  resend_available_at: inSeconds(60),
  attempts_remaining: 5,
};

function startSignup(otp = OTP) {
  useSignupStore.getState().start(
    { signup_id: 's1', otp },
    {
      first_name: 'Ada',
      last_name: 'Obi',
      email: 'ada@example.com',
      phone: '+2348031234567',
      date_of_birth: '1994-03-05',
      consent: { terms_version: '2026-10', privacy_version: '2026-10', accepted_at: inSeconds(0) },
    },
  );
}

async function renderVerify(dispatch: Dispatcher) {
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <RepositoryProvider repositories={repositoriesFromDispatcher(dispatch)}>
        <QueryProvider client={new QueryClient(NO_GC_TIMERS)}>
          <ThemeProvider initialPreference="dark">
            <VerifyEmailScreen />
          </ThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </SafeAreaProvider>,
  );
}

const codeField = () => screen.getByLabelText('Verification code, 6 digits');

describe('email OTP helpers', () => {
  it('formats the resend countdown', () => {
    expect(formatCountdown(60)).toBe('1:00');
    expect(formatCountdown(9)).toBe('0:09');
  });

  it('says how many attempts are left', () => {
    const wrong = problem(422, 'invalid_otp', 'That code is not right');
    expect(otpErrorMessage(wrong, 3)).toBe('That code is not right. 3 attempts left.');
    expect(otpErrorMessage(wrong, 1)).toBe('That code is not right. 1 attempt left.');
    expect(otpErrorMessage(wrong, 0)).toMatch(/last try/);
    expect(otpErrorMessage(problem(410, 'otp_expired', 'x'), 4)).toMatch(/expired/);
  });
});

describe('VerifyEmailScreen', () => {
  beforeEach(() => {
    mockPush.mockClear();
    startSignup();
  });

  it('verifies a pasted code, keeps the token and moves on to the password', async () => {
    const dispatch = jest.fn<ReturnType<Dispatcher>, Parameters<Dispatcher>>(async () => ({
      verification_token: 'verified_s1',
      expires_at: inSeconds(900),
    }));
    await renderVerify(dispatch);
    expect(screen.getByText(/a\*a@example.com/)).toBeOnTheScreen();

    await fireEvent.changeText(codeField(), 'Code: 123 456');

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/create-password'));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'verifyOtp',
        input: { body: { challenge_id: 's1', code: '123456' } },
      }),
    );
    expect(useSignupStore.getState().pending?.verificationToken).toBe('verified_s1');
  });

  it('counts down attempts on a wrong code', async () => {
    await renderVerify(async () => {
      throw problem(422, 'invalid_otp', 'That code is not right');
    });
    await fireEvent.changeText(codeField(), '000000');
    expect(await screen.findByText('That code is not right. 4 attempts left.')).toBeOnTheScreen();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('waits out the cooldown, then resends and resets the attempts', async () => {
    startSignup({ ...OTP, resend_available_at: inSeconds(-1), attempts_remaining: 1 });
    const dispatch = jest.fn<ReturnType<Dispatcher>, Parameters<Dispatcher>>(async () => ({
      ...OTP,
      resend_available_at: inSeconds(60),
    }));
    await renderVerify(dispatch);

    await fireEvent.press(screen.getByRole('button', { name: 'Resend code' }));

    expect(await screen.findByText('We sent a new code to a*a@example.com.')).toBeOnTheScreen();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'resendOtp', input: { body: { challenge_id: 's1' } } }),
    );
    expect(useSignupStore.getState().pending?.otp.attempts_remaining).toBe(5);
    expect(
      screen.getByRole('button', { name: /Resend code in 1:00|Resend code in 0:59/ }),
    ).toBeDisabled();
  });

  it('shows the resend countdown and explains that SMS is a paid feature', async () => {
    await renderVerify(jest.fn());
    expect(screen.getByRole('button', { name: /Resend code in (1:00|0:59)/ })).toBeDisabled();

    await fireEvent.press(screen.getByRole('button', { name: 'Use SMS instead' }));
    expect(await screen.findByText(/SMS one-time codes/)).toBeTruthy();
  });
});
