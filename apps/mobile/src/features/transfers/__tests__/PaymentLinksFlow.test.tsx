import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { isApiError, RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories, DEMO_PIN } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { useSessionStore } from '@/stores';
import { ThemeProvider } from '@/theme';

import { linkShareMessage, linkSubtitle } from '../paymentLinks';
import { NewPaymentLinkScreen } from '../screens/NewPaymentLinkScreen';
import { PayLinkScreen } from '../screens/PayLinkScreen';

const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
    back: jest.fn(),
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

const START = new Date('2026-10-21T12:00:00.000Z');
const naira = (major: number) => ({ amount_minor: String(major * 100), currency: 'NGN' as const });

function bank() {
  let now = START;
  const repos = createMockRepositories({
    store: createMemoryStore(),
    clock: () => now,
    simulation: { latency: 'off' },
  });
  return { repos, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

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

const ngn = async (repos: Repositories) =>
  (await repos.accounts.list()).data.find((a) => a.currency === 'NGN')!;
const balance = async (repos: Repositories) =>
  BigInt((await ngn(repos)).available_balance.amount_minor);

beforeEach(() => {
  mockPush.mockClear();
  mockReplace.mockClear();
  mockParams = {};
  useSessionStore.setState({ status: 'signedIn' });
});

it('creates a fixed-amount link that ends in 7 days', async () => {
  const { repos } = bank();
  await render(wrap(repos, <NewPaymentLinkScreen />));
  await fireEvent.changeText(screen.getByLabelText(/^What's it for/), ' Ankara fabric ');
  for (const key of ['1', '5', '0', '0', '0']) {
    await fireEvent.press(screen.getByRole('button', { name: key }));
  }
  await fireEvent.press(screen.getByRole('togglebutton', { name: '7 days' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create link' })).toBeEnabled());
  await fireEvent.press(screen.getByRole('button', { name: 'Create link' }));

  await waitFor(() => expect(mockReplace).toHaveBeenCalled());
  const { data } = await repos.paymentLinks.list();
  expect(data).toHaveLength(1);
  const link = data[0]!;
  expect(link).toMatchObject({ title: 'Ankara fabric', amount_mode: 'fixed', status: 'active' });
  expect(link.amount).toEqual(naira(15_000));
  expect(link.url).toBe(`https://nem-bank-fodx.vercel.app/pay/${link.slug}`);
  // The screen dates it from the device clock, the mock bank from its own.
  expect(Date.parse(link.expires_at!)).toBeGreaterThan(Date.now() + 6 * 86_400_000);
  expect(mockReplace).toHaveBeenCalledWith({
    pathname: '/send/links',
    params: { created: link.id },
  });
});

it("pays a friend's open link once with the PIN", async () => {
  const { repos } = bank();
  const before = await balance(repos);
  mockParams = { slug: 'emeka-birthday' };
  await render(wrap(repos, <PayLinkScreen />));
  expect(await screen.findByText("Emeka's birthday dinner")).toBeTruthy();
  expect(screen.getByText(/Emeka Nwosu is asking you/)).toBeTruthy();

  for (const key of ['5', '0', '0', '0']) {
    await fireEvent.press(screen.getByRole('button', { name: key }));
  }
  await fireEvent.press(await screen.findByRole('button', { name: 'Pay ₦5,000.00' }));
  await screen.findByText('Enter your PIN');
  // The amount keypad is still on the page; the PIN pad in the sheet comes last.
  for (const digit of DEMO_PIN) {
    await fireEvent.press(screen.getAllByRole('button', { name: digit }).at(-1)!);
  }

  await waitFor(() => expect(mockReplace).toHaveBeenCalled());
  expect(mockReplace.mock.calls[0]![0]).toMatchObject({ pathname: '/send/result/[id]' });
  expect(before - (await balance(repos))).toBe(500_000n);
});

it('tells the customer their own link is for sharing, not paying', async () => {
  const { repos } = bank();
  const link = await repos.paymentLinks.create({
    body: { account_id: (await ngn(repos)).id, title: 'Rent', amount_mode: 'open' },
  });
  mockParams = { slug: link.slug };
  await render(wrap(repos, <PayLinkScreen />));
  expect(await screen.findByText('This is your link')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Pay/ })).toBeNull();
});

it('asks someone signed out to log in before paying', async () => {
  useSessionStore.setState({ status: 'signedOut', session: null });
  const { repos } = bank();
  mockParams = { slug: 'emeka-birthday' };
  await render(wrap(repos, <PayLinkScreen />));
  await fireEvent.press(await screen.findByRole('button', { name: 'Log in to pay' }));
  expect(mockPush).toHaveBeenCalledWith('/login');
});

it("says so when a link doesn't exist", async () => {
  const { repos } = bank();
  mockParams = { slug: 'nope1234' };
  await render(wrap(repos, <PayLinkScreen />));
  expect(await screen.findByText("We can't find this link")).toBeTruthy();
});

describe('mock payment links', () => {
  it('refuses paused links and keeps other people’s links out of the list', async () => {
    const { repos } = bank();
    const source = (await ngn(repos)).id;
    const link = await repos.paymentLinks.create({
      body: { account_id: source, title: 'Fuel', amount_mode: 'fixed', amount: naira(2_000) },
    });
    expect((await repos.paymentLinks.list()).data.map((l) => l.slug)).toEqual([link.slug]);
    await repos.paymentLinks.update({ path: { link_id: link.id }, body: { status: 'inactive' } });
    expect((await repos.paymentLinks.getPublic({ path: { slug: link.slug } })).status).toBe(
      'inactive',
    );
    const own = await repos.paymentLinks
      .pay({
        path: { slug: link.slug },
        body: { source_account_id: source },
        idempotencyKey: 'k1',
      })
      .catch((e: unknown) => e);
    expect(isApiError(own) && own.code).toBe('invalid_state');
  });

  it('replays a repeated pay with the same key instead of paying twice', async () => {
    const { repos } = bank();
    const source = (await ngn(repos)).id;
    const before = await balance(repos);
    const request = {
      path: { slug: 'emeka-birthday' },
      body: { source_account_id: source, amount: naira(1_000) },
      idempotencyKey: 'same-key',
    };
    const first = await repos.paymentLinks.pay(request);
    const second = await repos.paymentLinks.pay(request);
    expect(second.id).toBe(first.id);
    expect(before - (await balance(repos))).toBe(100_000n);
  });

  it('has a friend pay a new link shortly after it is made', async () => {
    const { repos, advance } = bank();
    const before = await balance(repos);
    const link = await repos.paymentLinks.create({
      body: {
        account_id: (await ngn(repos)).id,
        title: 'Cake',
        amount_mode: 'fixed',
        amount: naira(8_000),
      },
    });
    advance(16_000);
    const [paid] = (await repos.paymentLinks.list()).data;
    expect(paid!.id).toBe(link.id);
    expect(paid!.payments_count).toBe(1);
    expect(paid!.total_received).toEqual(naira(8_000));
    expect((await balance(repos)) - before).toBe(800_000n);
  });
});

describe('payment link copy', () => {
  const link = {
    title: 'Cake',
    url: 'https://nem-bank-fodx.vercel.app/pay/abc',
    amount_mode: 'fixed' as const,
    amount: naira(8_000),
  };

  it('puts the amount and link in the share message', () => {
    expect(linkShareMessage(link)).toBe(
      'Pay me for Cake (₦8,000.00) with Nem: https://nem-bank-fodx.vercel.app/pay/abc',
    );
    expect(linkShareMessage({ ...link, amount_mode: 'open', amount: null })).toBe(
      'Pay me for Cake with Nem: https://nem-bank-fodx.vercel.app/pay/abc',
    );
  });

  it('summarises what a link has brought in', () => {
    const base = {
      ...link,
      id: '1',
      slug: 'abc',
      account_id: 'a',
      note: null,
      status: 'active' as const,
      expires_at: null,
      created_at: START.toISOString(),
    };
    expect(linkSubtitle({ ...base, payments_count: 0, total_received: naira(0) })).toBe(
      '₦8,000.00 · no payments yet',
    );
    expect(linkSubtitle({ ...base, payments_count: 2, total_received: naira(16_000) })).toBe(
      '₦8,000.00 · 2 payments · ₦16,000.00 in',
    );
  });
});
