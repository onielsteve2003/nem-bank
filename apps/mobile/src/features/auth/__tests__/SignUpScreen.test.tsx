import { QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { problem, repositoriesFromDispatcher, RepositoryProvider, type Dispatcher } from '@/data';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { SignUpScreen } from '../screens/SignUpScreen';
import { fieldForPointer, formatDateEntry, signupFormSchema, toSignupRequest } from '../signupForm';
import { useSignupStore } from '../signupStore';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

// Cache gc timers would keep Jest alive after the suite.
const NO_GC_TIMERS = {
  defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
};
const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const STARTED = {
  signup_id: 's1',
  otp: {
    challenge_id: 's1',
    channel: 'email',
    destination_masked: 'a*a@example.com',
    expires_at: '2026-10-19T12:10:00Z',
    resend_available_at: '2026-10-19T12:01:00Z',
    attempts_remaining: 5,
  },
};

async function renderSignUp(dispatch: Dispatcher) {
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <RepositoryProvider repositories={repositoriesFromDispatcher(dispatch)}>
        <QueryProvider client={new QueryClient(NO_GC_TIMERS)}>
          <ThemeProvider initialPreference="dark">
            <SignUpScreen />
          </ThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </SafeAreaProvider>,
  );
}

async function fill(values: Record<string, string>) {
  for (const [label, text] of Object.entries(values)) {
    await fireEvent.changeText(screen.getByLabelText(label), text);
  }
}

const VALID = {
  'First name': 'Ada',
  'Last name': 'Obi',
  Email: 'Ada@Example.com',
  'Phone number': '0803 123 4567',
  'Date of birth': '05031994',
};

describe('signup form helpers', () => {
  it('formats the date as it is typed', () => {
    expect(formatDateEntry('05')).toBe('05');
    expect(formatDateEntry('0503')).toBe('05/03');
    expect(formatDateEntry('05/03/19945')).toBe('05/03/1994');
  });

  it('builds the API request with E.164 phone, ISO date and a stamped consent record', () => {
    const values = signupFormSchema.parse({
      firstName: ' Ada ',
      lastName: 'Obi',
      email: 'Ada@Example.com',
      phone: '0803 123 4567',
      dateOfBirth: '05/03/1994',
      consent: true,
    });
    expect(toSignupRequest(values, new Date('2026-10-19T12:00:00Z'))).toEqual({
      first_name: 'Ada',
      last_name: 'Obi',
      email: 'ada@example.com',
      phone: '+2348031234567',
      date_of_birth: '1994-03-05',
      consent: {
        terms_version: '2026-10',
        privacy_version: '2026-10',
        accepted_at: '2026-10-19T12:00:00.000Z',
      },
    });
  });

  it('maps server field pointers onto form fields', () => {
    expect(fieldForPointer('/date_of_birth')).toBe('dateOfBirth');
    expect(fieldForPointer('/consent/accepted_at')).toBe('consent');
    expect(fieldForPointer('/nickname')).toBeNull();
  });
});

describe('SignUpScreen', () => {
  beforeEach(() => {
    mockPush.mockClear();
    useSignupStore.getState().clear();
  });

  it('shows every problem on submit and sends nothing', async () => {
    const dispatch = jest.fn<ReturnType<Dispatcher>, Parameters<Dispatcher>>();
    await renderSignUp(dispatch);
    await fill({ 'Phone number': '0603 123 4567', 'Date of birth': '01012015' });
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('Enter your first name')).toBeOnTheScreen();
    expect(screen.getByText('Enter a valid email address')).toBeOnTheScreen();
    expect(screen.getByText(/Enter a Nigerian mobile number/)).toBeOnTheScreen();
    expect(screen.getByText('You must be 18 or older to open an account')).toBeOnTheScreen();
    expect(screen.getByText(/Agree to the terms/)).toBeOnTheScreen();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('starts sign-up, keeps the challenge in memory and moves to email verification', async () => {
    const dispatch = jest.fn<ReturnType<Dispatcher>, Parameters<Dispatcher>>(async () => STARTED);
    await renderSignUp(dispatch);
    await fill(VALID);
    await fireEvent.press(screen.getByRole('checkbox'));
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/verify-email'));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'startSignup',
        input: {
          body: expect.objectContaining({ email: 'ada@example.com', phone: '+2348031234567' }),
        },
      }),
    );
    expect(useSignupStore.getState().pending).toMatchObject({
      signup_id: 's1',
      request: { date_of_birth: '1994-03-05' },
    });
  });

  it('puts a server field error on its field', async () => {
    const dispatch: Dispatcher = async () => {
      throw problem(409, 'email_taken', 'An account already uses this email', {
        errors: [
          { field: '/email', code: 'taken', message: 'An account already uses this email.' },
        ],
      });
    };
    await renderSignUp(dispatch);
    await fill(VALID);
    await fireEvent.press(screen.getByRole('checkbox'));
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('An account already uses this email.')).toBeOnTheScreen();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
