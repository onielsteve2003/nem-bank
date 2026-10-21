import { parseMajor } from '@nem/shared';
import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories, DEMO_PIN } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { toApiMoney } from '@/lib/money';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { ReviewScreen } from '../screens/ReviewScreen';
import { ScheduledScreen } from '../screens/ScheduledScreen';
import { recipientFromBeneficiary, useSendDraft } from '../sendDraft';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
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

const amaka = async (repos: Repositories) =>
  (await repos.beneficiaries.list()).data.find((b) => b.name === 'Amaka Obi')!;
const ngn = async (repos: Repositories) =>
  (await repos.accounts.list()).data.find((a) => a.currency === 'NGN')!;

beforeEach(() => {
  mockReplace.mockClear();
  useSendDraft.getState().clear();
});

it('schedules a weekly payment from the review screen without moving money today', async () => {
  const repos = bank();
  useSendDraft.getState().setRecipient(recipientFromBeneficiary(await amaka(repos)));
  useSendDraft.getState().setAmount('5000', 'Allowance');
  const before = (await ngn(repos)).available_balance.amount_minor;
  await render(wrap(repos, <ReviewScreen />));

  await fireEvent.press(await screen.findByRole('button', { name: 'When: now' }));
  await fireEvent.press(await screen.findByRole('togglebutton', { name: 'Every week' }));
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'In a week' }));
  expect(screen.getByText(/^Every week from .*at about 9 am/)).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Use this schedule' }));

  const go = await screen.findByRole('button', { name: 'Schedule ₦5,000.00' });
  await waitFor(() => expect(go).not.toBeDisabled());
  await fireEvent.press(go);
  await screen.findByText('Enter your PIN');
  for (const digit of DEMO_PIN) await fireEvent.press(screen.getByRole('button', { name: digit }));

  await waitFor(() => expect(mockReplace).toHaveBeenCalled());
  const { data } = await repos.transfers.listScheduled();
  expect(data).toHaveLength(1);
  expect(data[0]).toMatchObject({ frequency: 'weekly', status: 'active', narration: 'Allowance' });
  expect(data[0]!.next_run_at).toMatch(/T08:00:00/);
  expect(mockReplace).toHaveBeenCalledWith({
    pathname: '/send/scheduled',
    params: { created: data[0]!.id },
  });
  expect((await ngn(repos)).available_balance.amount_minor).toBe(before);
});

it('pauses, resumes and cancels a schedule', async () => {
  const repos = bank();
  const b = await amaka(repos);
  const created = await repos.transfers.createScheduled({
    idempotencyKey: 'sched-1',
    body: {
      source_account_id: (await ngn(repos)).id,
      destination: { kind: 'beneficiary', beneficiary_id: b.id },
      amount: toApiMoney(parseMajor('2500', 'NGN')),
      frequency: 'monthly',
      start_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    },
  });
  const status = async () =>
    (await repos.transfers.getScheduled({ path: { schedule_id: created.id } })).status;
  await render(wrap(repos, <ScheduledScreen />));

  await fireEvent.press(await screen.findByRole('button', { name: /^Amaka Obi, ₦2,500\.00/ }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Pause' }));
  await waitFor(async () => expect(await status()).toBe('paused'));
  await fireEvent.press(await screen.findByRole('button', { name: 'Resume' }));
  await waitFor(async () => expect(await status()).toBe('active'));

  await fireEvent.press(await screen.findByRole('button', { name: 'Pause' }));
  await waitFor(async () => expect(await status()).toBe('paused'));
  await fireEvent.press(screen.getAllByRole('button', { name: 'Cancel schedule' })[0]!);
  await fireEvent.press(await screen.findByRole('button', { name: 'Keep it' }));
  expect(await status()).toBe('paused');
  await fireEvent.press(screen.getAllByRole('button', { name: 'Cancel schedule' })[0]!);
  const dialogButtons = screen.getAllByRole('button', { name: 'Cancel schedule' });
  await fireEvent.press(dialogButtons.at(-1)!);
  await waitFor(async () => expect(await status()).toBe('cancelled'));
  expect(await screen.findByText('Ended')).toBeTruthy();
});
