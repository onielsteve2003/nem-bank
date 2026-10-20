import { parseMajor } from '@nem/shared';
import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories, DEMO_OTP, DEMO_PIN } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { toApiMoney } from '@/lib/money';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { ReviewScreen } from '../screens/ReviewScreen';
import { TransferResultScreen } from '../screens/TransferResultScreen';
import { recipientFromBeneficiary, useSendDraft } from '../sendDraft';

let mockParams: Record<string, string> = {};
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: mockReplace,
    back: jest.fn(),
    dismissTo: jest.fn(),
    canGoBack: () => true,
  }),
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

/** A saved beneficiary and an amount in the draft, as the amount screen leaves it. */
async function draft(repos: Repositories, amount: string, name = 'Amaka Obi') {
  const { data } = await repos.beneficiaries.list();
  const b = data.find((x) => x.name === name)!;
  useSendDraft.getState().setRecipient(recipientFromBeneficiary(b));
  useSendDraft.getState().setAmount(amount, 'Rent');
}

async function fund(repos: Repositories, major: number) {
  const { data } = await repos.accounts.list();
  const ngn = data.find((a) => a.currency === 'NGN')!;
  await repos.demo.fundWallet({
    body: { account_id: ngn.id, amount: toApiMoney(parseMajor(String(major), 'NGN')) },
  } as Parameters<Repositories['demo']['fundWallet']>[0]);
}

async function confirmWithPin(pin = DEMO_PIN) {
  const send = await screen.findByRole('button', { name: /^Send ₦/ });
  // Enabled once the fee has loaded.
  await waitFor(() => expect(send).not.toBeDisabled());
  await fireEvent.press(send);
  await screen.findByText('Enter your PIN');
  for (const digit of pin) await fireEvent.press(screen.getByRole('button', { name: digit }));
}

const resultId = () => mockReplace.mock.calls.at(-1)![0].params.id as string;

beforeEach(() => {
  mockReplace.mockClear();
  mockParams = {};
  useSendDraft.getState().clear();
});

describe('review and confirm', () => {
  it('sends once with the PIN and opens the result', async () => {
    const repos = bank();
    await draft(repos, '5000');
    await render(wrap(repos, <ReviewScreen />));
    expect(await screen.findByText('Rent')).toBeTruthy();

    await confirmWithPin();
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    const transfer = await repos.transfers.get({ path: { transfer_id: resultId() } });
    expect(transfer.status).toBe('completed');
    expect(transfer.narration).toBe('Rent');
    expect(useSendDraft.getState().recipient).toBeNull();
  });

  it('keeps the pad open on a wrong PIN and sends nothing', async () => {
    const repos = bank();
    await draft(repos, '5000');
    await render(wrap(repos, <ReviewScreen />));
    await confirmWithPin('1111');
    expect(await screen.findByText(/Wrong PIN\. \d tries left/)).toBeTruthy();
    expect(mockReplace).not.toHaveBeenCalled();
    const { data } = await repos.transfers.list();
    expect(data.some((t) => t.narration === 'Rent')).toBe(false);
  });

  it('finishes a risk step-up with the emailed code', async () => {
    const repos = bank();
    await fund(repos, 1_000_000);
    await draft(repos, '900000');
    await render(wrap(repos, <ReviewScreen />));
    await confirmWithPin();

    expect(await screen.findByText('One more check')).toBeTruthy();
    expect(screen.getByText(/You usually send about/)).toBeTruthy();
    await fireEvent.changeText(await screen.findByLabelText(/^Verification code/), DEMO_OTP);
    await waitFor(() => expect(mockReplace).toHaveBeenCalled(), { timeout: 4000 });
    const transfer = await repos.transfers.get({ path: { transfer_id: resultId() } });
    expect(transfer.status).toBe('completed');
  });
});

describe('result', () => {
  it('shows why a large payment is held and lets the customer cancel it', async () => {
    const repos = bank();
    await fund(repos, 3_000_000);
    await draft(repos, '2500000');
    await render(wrap(repos, <ReviewScreen />));
    await confirmWithPin();
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());

    mockParams = { id: resultId() };
    await render(wrap(repos, <TransferResultScreen />));
    expect(await screen.findByText('Held for a quick review')).toBeTruthy();
    expect(screen.getByText('Why we are checking')).toBeTruthy();
    expect(screen.getByText(/far larger than anything you have sent/)).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Cancel payment' }));
    expect(await screen.findByText('Not sent')).toBeTruthy();
    expect((await repos.transfers.get({ path: { transfer_id: mockParams.id! } })).status).toBe(
      'cancelled',
    );
  });
});
