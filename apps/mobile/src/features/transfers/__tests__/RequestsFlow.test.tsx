import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories, DEMO_PIN } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { RequestMoneyScreen } from '../screens/RequestMoneyScreen';
import { RequestsScreen } from '../screens/RequestsScreen';

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    back: jest.fn(),
    dismissTo: jest.fn(),
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => ({}),
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
  createMockRepositories({ store: createMemoryStore(), simulation: { latency: 'off' } });

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

const suya = async (repos: Repositories) =>
  (await repos.moneyRequests.list({ query: { direction: 'incoming' } })).data[0]!;
const balance = async (repos: Repositories) =>
  BigInt(
    (await repos.accounts.list()).data.find((a) => a.currency === 'NGN')!.available_balance
      .amount_minor,
  );

beforeEach(() => {
  mockPush.mockClear();
  mockReplace.mockClear();
});

it('pays an incoming request once with the PIN', async () => {
  const repos = bank();
  const before = await balance(repos);
  await render(wrap(repos, <RequestsScreen />));
  expect(await screen.findByRole('togglebutton', { name: 'To pay (1)' })).toBeTruthy();

  await fireEvent.press(await screen.findByRole('button', { name: /^Amaka Obi, ₦7,500\.00/ }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Pay ₦7,500.00' }));
  await screen.findByText('Enter your PIN');
  for (const digit of DEMO_PIN) await fireEvent.press(screen.getByRole('button', { name: digit }));

  await waitFor(() => expect(mockPush).toHaveBeenCalled());
  const paid = await suya(repos);
  expect(paid.status).toBe('paid');
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/send/result/[id]',
    params: { id: paid.transfer_id },
  });
  expect(before - (await balance(repos))).toBe(750_000n);
});

it('declines an incoming request after confirming', async () => {
  const repos = bank();
  await render(wrap(repos, <RequestsScreen />));
  await fireEvent.press(await screen.findByRole('button', { name: /^Amaka Obi, ₦7,500\.00/ }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Decline' }));
  const declines = screen.getAllByRole('button', { name: 'Decline' });
  await fireEvent.press(declines.at(-1)!);
  await waitFor(async () => expect((await suya(repos)).status).toBe('declined'));
});

it('requests money from a Nem user', async () => {
  const repos = bank();
  await render(wrap(repos, <RequestMoneyScreen />));
  await fireEvent.changeText(screen.getByLabelText(/^From/), '@emeka');
  expect(await screen.findByText('Emeka Nwosu')).toBeTruthy();
  for (const key of ['2', '0', '0', '0']) {
    await fireEvent.press(screen.getByRole('button', { name: key }));
  }
  await fireEvent.changeText(screen.getByLabelText(/^What's it for/), ' Fuel ');
  await fireEvent.press(screen.getByRole('togglebutton', { name: '30 days' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Request ₦2,000.00 from Emeka' }));

  await waitFor(() => expect(mockReplace).toHaveBeenCalled());
  const { data } = await repos.moneyRequests.list({ query: { direction: 'outgoing' } });
  expect(data).toHaveLength(1);
  expect(data[0]).toMatchObject({ note: 'Fuel', status: 'pending' });
  expect(data[0]!.payer.nemtag).toBe('emeka');
  expect(Date.parse(data[0]!.expires_at) - Date.parse(data[0]!.created_at)).toBe(30 * 86_400_000);
  expect(mockReplace).toHaveBeenCalledWith({
    pathname: '/send/requests',
    params: { tab: 'sent', created: data[0]!.id },
  });
});
