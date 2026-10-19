import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '@/theme';

import { CreatePasswordScreen } from '../screens/CreatePasswordScreen';
import { CreatePinScreen, weakPinMessage } from '../screens/CreatePinScreen';
import { useSignupStore } from '../signupStore';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  Redirect: () => null,
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));
jest.mock('@/lib/screenCapture', () => ({ useSecureScreen: jest.fn() }));

const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function startVerifiedSignup() {
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
      last_name: 'Obiora',
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
}

const renderScreen = (ui: React.ReactElement) =>
  render(
    <SafeAreaProvider initialMetrics={metrics}>
      <ThemeProvider initialPreference="dark">{ui}</ThemeProvider>
    </SafeAreaProvider>,
  );

async function typePin(pin: string) {
  for (const digit of pin) await fireEvent.press(screen.getByRole('button', { name: digit }));
}

beforeEach(() => {
  mockPush.mockClear();
  startVerifiedSignup();
});

describe('CreatePasswordScreen', () => {
  it('rates the password as it is typed and refuses one with the user’s name', async () => {
    await renderScreen(<CreatePasswordScreen />);
    await fireEvent.changeText(screen.getByLabelText('Password'), 'Obiora#Vault88');
    expect(screen.getByLabelText('Password strength')).toHaveAccessibilityValue({
      text: 'Weak',
    });

    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Leave out your name, email and birth year')).toBeOnTheScreen();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('keeps a strong password in memory and moves on to the PIN', async () => {
    await renderScreen(<CreatePasswordScreen />);
    await fireEvent.changeText(screen.getByLabelText('Password'), 'Kitchen-Mango-River-7');
    expect(screen.getByText('Good to go')).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(mockPush).toHaveBeenCalledWith('/create-pin');
    expect(useSignupStore.getState().pending?.password).toBe('Kitchen-Mango-River-7');
  });
});

describe('CreatePinScreen', () => {
  beforeEach(() => useSignupStore.getState().setPassword('Kitchen-Mango-River-7'));

  it('explains weak and birthday PINs', () => {
    expect(weakPinMessage('1111')).toMatch(/Too easy to guess/);
    expect(weakPinMessage('0503', '1994-03-05')).toMatch(/date of birth/);
    expect(weakPinMessage('2580', '1994-03-05')).toBeUndefined();
  });

  it('refuses a birthday PIN, then asks for the PIN twice', async () => {
    await renderScreen(<CreatePinScreen />);
    await typePin('1994');
    expect(await screen.findByText(/date of birth/)).toBeOnTheScreen();

    await typePin('2580');
    expect(await screen.findByText('Confirm your PIN')).toBeOnTheScreen();
    await typePin('2580');

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/enable-biometrics'));
    expect(useSignupStore.getState().pending?.pin).toBe('2580');
  });

  it('starts again when the confirmation does not match', async () => {
    await renderScreen(<CreatePinScreen />);
    await typePin('2580');
    expect(await screen.findByText('Confirm your PIN')).toBeOnTheScreen();
    await typePin('2581');

    expect(await screen.findByText(/didn't match/)).toBeOnTheScreen();
    expect(screen.getByText('Create your PIN')).toBeOnTheScreen();
    expect(mockPush).not.toHaveBeenCalled();
  });
});
