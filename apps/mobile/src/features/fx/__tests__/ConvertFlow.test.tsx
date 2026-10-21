import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories, DEMO_PIN } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { ConvertScreen } from '../screens/ConvertScreen';

let mockParams: Record<string, string> = {};
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: mockBack, canGoBack: () => true }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));
jest.mock('expo-local-authentication', () => ({
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2 },
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  supportedAuthenticationTypesAsync: jest.fn(async () => []),
  authenticateAsync: jest.fn(async () => ({ success: false })),
}));

configure({ defaultIncludeHiddenElements: true });

const bank = () =>
  createMockRepositories({
    store: createMemoryStore(),
    clock: () => new Date(Date.now()),
    simulation: { latency: 'off' },
  });

const wrap = (repos: Repositories, ui: React.ReactElement) => (
  <SafeAreaProvider
    initialMetrics={{
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 47, left: 0, right: 0, bottom: 34 },
    }}
  >
    <RepositoryProvider repositories={repos}>
      <QueryProvider
        client={
          new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
        }
      >
        <ThemeProvider initialPreference="dark">
          <ToastProvider>
            <ModalSheetHost>{ui}</ModalSheetHost>
          </ToastProvider>
        </ThemeProvider>
      </QueryProvider>
    </RepositoryProvider>
  </SafeAreaProvider>
);

const press = async (keys: string) => {
  for (const k of keys) await fireEvent.press(screen.getByRole('button', { name: k }));
};

/** The PIN pad opens over the amount keypad: its keys are the last ones rendered. */
const enterPin = async () => {
  for (const k of DEMO_PIN)
    await fireEvent.press(screen.getAllByRole('button', { name: k }).at(-1)!);
};

const walletBalance = async (repos: Repositories, currency: string) => {
  const { data } = await repos.accounts.list();
  return BigInt(data.find((a) => a.currency === currency)!.available_balance.amount_minor);
};

beforeEach(() => {
  mockParams = {};
  mockBack.mockClear();
  jest.restoreAllMocks();
});

describe('convert', () => {
  it('prices naira into dollars with the spread shown, then converts with the PIN', async () => {
    const repos = bank();
    const usdBefore = await walletBalance(repos, 'USD');
    await render(wrap(repos, <ConvertScreen />));
    await screen.findByLabelText(/^Available/);
    await press('16000');

    expect(await screen.findByText('Your rate')).toBeTruthy();
    // The customer's rate and the mid-market rate, both read as naira per dollar.
    expect(screen.getAllByText(/^\$1 = ₦1,/)).toHaveLength(2);
    expect(screen.getByText('Spread (1.5%)')).toBeTruthy();
    expect(screen.getByText('Free')).toBeTruthy();
    expect(screen.getByLabelText(/^Rate held for \d+ seconds/)).toBeTruthy();

    const convert = screen.getByRole('button', { name: 'Convert ₦16,000.00' });
    await waitFor(() => expect(convert).toBeEnabled());
    await fireEvent.press(convert);
    await screen.findByText('Enter your PIN');
    await enterPin();

    expect(await screen.findByText('Converted')).toBeTruthy();
    expect(await walletBalance(repos, 'USD')).toBeGreaterThan(usdBefore);
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(mockBack).toHaveBeenCalled();
  });

  it('swaps to sell dollars for naira', async () => {
    await render(wrap(bank(), <ConvertScreen />));
    await screen.findByLabelText(/^Available/);
    await fireEvent.press(screen.getByRole('button', { name: /^Swap: convert USD to NGN/ }));
    expect(await screen.findByText('Foreign wallets convert back to naira.')).toBeTruthy();
    await press('10');
    expect(await screen.findByRole('button', { name: 'Convert $10.00' })).toBeTruthy();
  });

  it('stops an amount above the wallet balance', async () => {
    await render(wrap(bank(), <ConvertScreen />));
    await screen.findByLabelText(/^Available/);
    await press('900000000');
    expect(await screen.findByText(/More than your available/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Convert ₦/ })).toBeDisabled();
  });

  it('asks for a new rate once the 60 seconds are up', async () => {
    await render(wrap(bank(), <ConvertScreen />));
    await screen.findByLabelText(/^Available/);
    await press('5000');
    await screen.findByText('Your rate');

    const later = Date.now() + 61_000;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    const again = await screen.findByRole('button', { name: 'Get a new rate' }, { timeout: 3000 });
    expect(screen.getByRole('button', { name: 'Convert ₦5,000.00' })).toBeDisabled();

    await fireEvent.press(again);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Convert ₦5,000.00' })).toBeEnabled(),
    );
    expect(screen.getByLabelText(/^Rate held for/)).toBeTruthy();
  });
});
