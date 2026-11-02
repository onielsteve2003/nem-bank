import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories, DEMO_PIN } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { DeleteAccountScreen } from '../screens/DeleteAccountScreen';
import { YourDataScreen } from '../screens/YourDataScreen';

const mockPush = jest.fn();
const mockDismissTo = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, dismissTo: mockDismissTo, back: jest.fn() }),
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
    clock: () => new Date('2026-11-02T10:00:00Z'),
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
      <QueryProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider initialPreference="dark">
          <ToastProvider>
            <ModalSheetHost>{ui}</ModalSheetHost>
          </ToastProvider>
        </ThemeProvider>
      </QueryProvider>
    </RepositoryProvider>
  </SafeAreaProvider>
);

/** The same bank with every wallet emptied, so deletion is allowed. */
const emptied = async (repos: Repositories): Promise<Repositories> => {
  const { data } = await repos.accounts.list();
  const zero = data.map((a) => ({
    ...a,
    ledger_balance: { ...a.ledger_balance, amount_minor: '0' },
    available_balance: { ...a.available_balance, amount_minor: '0' },
  }));
  const requestDeletion = jest.fn(repos.privacy.requestDeletion);
  // The mock still holds the money, so answer as the bank would once it's gone.
  requestDeletion.mockImplementation(async ({ stepUpToken }) => {
    expect(stepUpToken).toEqual(expect.any(String));
    return {
      id: 'del_1',
      kind: 'deletion',
      status: 'received',
      requested_at: '2026-11-02T10:00:00Z',
      completes_by: '2026-12-02T10:00:00Z',
    };
  });
  return {
    ...repos,
    accounts: { ...repos.accounts, list: async () => ({ data: zero }) },
    privacy: { ...repos.privacy, requestDeletion },
  };
};

beforeEach(() => jest.clearAllMocks());

describe('YourDataScreen', () => {
  it('requests an export and says where and by when it will arrive', async () => {
    const repos = bank();
    const { email } = await repos.users.getMe();
    await render(wrap(repos, <YourDataScreen />));

    await fireEvent.press(await screen.findByRole('button', { name: 'Request my data' }));
    expect(await screen.findByText('Requested on 2 Nov 2026')).toBeOnTheScreen();
    expect(
      screen.getByText(`We'll email it to ${email} by 2 Dec 2026 at the latest.`),
    ).toBeTruthy();

    await fireEvent.press(screen.getByText('Delete my account'));
    expect(mockPush).toHaveBeenCalledWith('/settings/delete-account');
  });
});

describe('DeleteAccountScreen', () => {
  it('blocks deletion while a wallet still holds money', async () => {
    await render(wrap(bank(), <DeleteAccountScreen />));
    expect(await screen.findByText('Move your money out first')).toBeOnTheScreen();
    expect(screen.getByText('NGN wallet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete my account' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Send money' }));
    expect(mockPush).toHaveBeenCalledWith('/send');
  });

  it('deletes with a PIN step-up once every balance is zero', async () => {
    const repos = await emptied(bank());
    await render(wrap(repos, <DeleteAccountScreen />));
    expect(await screen.findByText('All your balances are zero.')).toBeOnTheScreen();

    const button = screen.getByRole('button', { name: 'Delete my account' });
    expect(button).toBeDisabled();
    await fireEvent.press(screen.getByText("I understand this can't be undone"));
    await fireEvent.press(button);
    for (const digit of DEMO_PIN)
      await fireEvent.press(screen.getByRole('button', { name: digit }));

    expect(await screen.findByText('Deletion requested')).toBeOnTheScreen();
    expect(repos.privacy.requestDeletion).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(mockDismissTo).toHaveBeenCalledWith('/me');
  });
});
