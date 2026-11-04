import type { AuthSession, Schema } from '@nem/contracts';
import { QueryClient } from '@tanstack/react-query';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { useEffect, useReducer, type ComponentType } from 'react';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories, DEMO_OTP, DEMO_PIN } from '@/data/mock';
import { createMemoryStore, type SnapshotStore } from '@/data/mock/persistence/types';
import { useSendDraft } from '@/features/transfers/sendDraft';
import { QueryProvider } from '@/lib/query';
import { useSignupStore } from '@/features/auth/signupStore';
import { useSessionStore } from '@/stores';
import { ThemeProvider } from '@/theme';

import AjoGroupRoute from '../../../../app/(app)/ajo/group/[id]';
import AjoListRoute from '../../../../app/(app)/ajo/index';
import CardsRoute from '../../../../app/(app)/(tabs)/cards';
import ConvertRoute from '../../../../app/(app)/convert/index';
import DemoControlsRoute from '../../../../app/(app)/demo-controls';
import AmountRoute from '../../../../app/(app)/send/amount';
import SendHubRoute from '../../../../app/(app)/send/index';
import RecipientRoute from '../../../../app/(app)/send/recipient';
import TransferResultRoute from '../../../../app/(app)/send/result/[id]';
import ReviewRoute from '../../../../app/(app)/send/review';
import CreatePasswordRoute from '../../../../app/(auth)/create-password';
import CreatePinRoute from '../../../../app/(auth)/create-pin';
import EnableBiometricsRoute from '../../../../app/(auth)/enable-biometrics';
import SignUpRoute from '../../../../app/(auth)/sign-up';
import VerifyEmailRoute from '../../../../app/(auth)/verify-email';
import WelcomeRoute from '../../../../app/(auth)/welcome';
import ChooseNemtagRoute from '../../../../app/choose-nemtag';

/*
 * Critical journeys end to end (T21.3): real route files and screens, one mock bank, and the
 * ledger checked afterwards. A small in-memory router stands in for Expo Router: push and
 * replace render whichever route the screen navigates to, so a wrong href fails the test.
 */

type Route = { path: string; params: Record<string, string> };
type Href = string | { pathname: string; params?: Record<string, string | undefined> };

const mockNav = {
  routes: {} as Record<string, ComponentType>,
  stack: [] as Route[],
  render: () => undefined as void,
  /** The route pattern (e.g. /send/result/[id]) a concrete path belongs to, with its params. */
  match(path: string): { pattern: string; params: Record<string, string> } | null {
    const parts = path.split('/');
    for (const pattern of Object.keys(this.routes)) {
      const want = pattern.split('/');
      if (want.length !== parts.length) continue;
      const params: Record<string, string> = {};
      if (
        want.every((w, i) => {
          const dynamic = /^\[(\w+)\]$/.exec(w);
          if (dynamic) params[dynamic[1]!] = parts[i]!;
          return dynamic !== null || w === parts[i];
        })
      ) {
        return { pattern, params };
      }
    }
    return null;
  },
  resolve(href: Href): Route {
    if (typeof href === 'string') {
      const [path, query = ''] = href.split('?');
      return { path: path!, params: Object.fromEntries(new URLSearchParams(query)) };
    }
    const params = Object.fromEntries(
      Object.entries(href.params ?? {}).filter((e): e is [string, string] => e[1] !== undefined),
    );
    const path = href.pathname.replace(/\[(\w+)\]/g, (_, key: string) => params[key] ?? '');
    return { path, params };
  },
  go(href: Href, replace = false) {
    if (replace) this.stack.pop();
    this.stack.push(this.resolve(href));
    this.render();
  },
  top(): Route {
    return this.stack.at(-1)!;
  },
};

const mockRouter = {
  push: (href: Href) => mockNav.go(href),
  navigate: (href: Href) => mockNav.go(href),
  replace: (href: Href) => mockNav.go(href, true),
  dismissTo: (href: Href) => mockNav.go(href, true),
  back: () => {
    if (mockNav.stack.length > 1) mockNav.stack.pop();
    mockNav.render();
  },
  canGoBack: () => mockNav.stack.length > 1,
};

jest.mock('expo-router', () => {
  const { useEffect: useMountEffect } = jest.requireActual<typeof import('react')>('react');
  return {
    useRouter: () => mockRouter,
    useLocalSearchParams: () => {
      const top = mockNav.top();
      return { ...mockNav.match(top.path)?.params, ...top.params };
    },
    useFocusEffect: (effect: () => void) => useMountEffect(effect, [effect]),
    Redirect: ({ href }: { href: Href }) => {
      useMountEffect(() => mockRouter.replace(href), [href]);
      return null;
    },
  };
});
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));
jest.mock('@/lib/screenCapture', () => ({ useSecureScreen: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
// A phone without Face ID or a fingerprint: every money action is approved with the PIN.
jest.mock('@/lib/biometrics', () => ({
  NO_BIOMETRICS: { available: false, label: '' },
  getBiometrics: jest.fn(async () => ({ available: false, label: '' })),
  authenticateWithBiometrics: jest.fn(async () => false),
}));
jest.mock('expo-local-authentication', () => ({
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2 },
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  supportedAuthenticationTypesAsync: jest.fn(async () => []),
  authenticateAsync: jest.fn(async () => ({ success: false })),
}));

configure({ defaultIncludeHiddenElements: true });
// Each test is a whole journey over a freshly seeded bank.
jest.setTimeout(30_000);

function Navigator() {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    mockNav.render = rerender;
    return () => {
      mockNav.render = () => undefined;
    };
  }, []);
  const { path } = mockNav.top();
  const found = mockNav.match(path);
  if (!found) return <Text>{`Not part of this journey: ${path}`}</Text>;
  const Screen = mockNav.routes[found.pattern]!;
  return <Screen key={path} />;
}

const clients: QueryClient[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.clear()));

/** Opens the app at `start` with only `routes` reachable. */
async function open(repos: Repositories, routes: Record<string, ComponentType>, start: string) {
  mockNav.routes = routes;
  mockNav.stack = [mockNav.resolve(start)];
  const client = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false },
      mutations: { gcTime: Infinity },
    },
  });
  clients.push(client);
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <RepositoryProvider repositories={repos}>
        <QueryProvider client={client}>
          <ThemeProvider initialPreference="dark">
            <ToastProvider>
              <ModalSheetHost>
                <Navigator />
              </ModalSheetHost>
            </ToastProvider>
          </ThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </SafeAreaProvider>,
  );
}

/**
 * Waits until nothing is loading or saving. A refetch still running when a test ends finishes
 * inside the next test's act() scope, and React then drops that test's tree.
 */
const settle = () =>
  waitFor(() => expect(clients.every((c) => !c.isFetching() && !c.isMutating())).toBe(true));

const bank = (store: SnapshotStore = createMemoryStore()) =>
  createMockRepositories({ store, simulation: { latency: 'off' } });

const at = async (path: string) => waitFor(() => expect(mockNav.top().path).toBe(path));

async function tap(...keys: string[]) {
  for (const key of keys.join('')) {
    // The PIN sheet's keypad is drawn last when an amount keypad is also on screen.
    await fireEvent.press((await screen.findAllByRole('button', { name: key })).at(-1)!);
  }
}

const wallet = async (repos: Repositories, currency: string) => {
  const { data } = await repos.accounts.list();
  const account = data.find((a) => a.currency === currency)!;
  return {
    id: account.id,
    minor: BigInt(account.available_balance.amount_minor),
    ledger: BigInt(account.ledger_balance.amount_minor),
  };
};

const signed = (t: Schema<'Transaction'>) =>
  (t.direction === 'debit' ? -1n : 1n) * BigInt(t.amount.amount_minor);

const demoSession = (): AuthSession => ({
  access_token: 'a',
  access_token_expires_at: new Date(Date.now() + 600_000).toISOString(),
  refresh_token: 'r',
  refresh_token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  token_type: 'Bearer',
  user: { id: 'u', is_demo: true } as AuthSession['user'],
  device: { id: 'd' } as AuthSession['device'],
});

beforeEach(() => {
  useSendDraft.getState().clear();
  useSignupStore.getState().clear();
  useSessionStore.setState({ status: 'signedOut', session: null });
});

const NEW_PIN = '4713';

it('onboarding: signs up, verifies the email, sets a password and PIN, opens the account and claims an @nemtag', async () => {
  const repos = bank();
  await open(
    repos,
    {
      '/welcome': WelcomeRoute,
      '/sign-up': SignUpRoute,
      '/verify-email': VerifyEmailRoute,
      '/create-password': CreatePasswordRoute,
      '/create-pin': CreatePinRoute,
      '/enable-biometrics': EnableBiometricsRoute,
      '/choose-nemtag': ChooseNemtagRoute,
    },
    '/welcome',
  );

  await fireEvent.press(screen.getByRole('button', { name: 'Create account' }));
  await at('/sign-up');
  const details = {
    'First name': 'Ada',
    'Last name': 'Obi',
    Email: 'ada.obi@example.com',
    'Phone number': '0803 123 4567',
    'Date of birth': '05031994',
  };
  for (const [label, text] of Object.entries(details)) {
    await fireEvent.changeText(screen.getByLabelText(label), text);
  }
  await fireEvent.press(screen.getByRole('checkbox'));
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));

  await at('/verify-email');
  await fireEvent.changeText(screen.getByLabelText('Verification code, 6 digits'), DEMO_OTP);

  await at('/create-password');
  await fireEvent.changeText(screen.getByLabelText('Password'), 'Kitchen-Mango-River-7');
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));

  await at('/create-pin');
  await tap(NEW_PIN);
  await screen.findByText('Confirm your PIN');
  await tap(NEW_PIN);

  await at('/enable-biometrics');
  await fireEvent.press(await screen.findByRole('button', { name: 'Open my account' }));
  await waitFor(() => expect(useSessionStore.getState().status).toBe('signedIn'));
  // Nothing from sign-up (password, PIN) stays in memory once the account exists.
  expect(useSignupStore.getState().pending).toBeNull();

  // The route gate sends a new account without an @nemtag to the chooser.
  expect(useSessionStore.getState().session?.needsNemtag).toBe(true);
  await act(async () => mockRouter.replace('/choose-nemtag'));
  await fireEvent.changeText(await screen.findByLabelText('@nemtag'), 'ada_obi');
  await fireEvent.press(await screen.findByRole('button', { name: 'Claim @ada_obi' }));
  await waitFor(() => expect(useSessionStore.getState().session?.needsNemtag).toBe(false));

  const me = await repos.users.getMe();
  expect(me).toMatchObject({ first_name: 'Ada', last_name: 'Obi', nemtag: 'ada_obi' });
  // The offline demo has one customer, so a sign-up takes over its wallets; what onboarding
  // sets is the new PIN and a fresh Tier 1 KYC record.
  expect(await repos.users.verifyPin({ body: { pin: NEW_PIN } })).toMatchObject({ valid: true });
  expect((await repos.users.verifyPin({ body: { pin: DEMO_PIN } })).valid).toBe(false);
  expect((await repos.kyc.getOverview()).tier).toBe(1);
  await settle();
});

it('send money: finds a Nem user, prices the payment, confirms with the PIN and debits exactly that', async () => {
  const repos = bank();
  const before = await wallet(repos, 'NGN');
  await open(
    repos,
    {
      '/send': SendHubRoute,
      '/send/recipient': RecipientRoute,
      '/send/amount': AmountRoute,
      '/send/review': ReviewRoute,
      '/send/result/[id]': TransferResultRoute,
    },
    '/send',
  );

  await fireEvent.press(await screen.findByRole('button', { name: /^To a Nem user/ }));
  await at('/send/recipient');
  await fireEvent.changeText(screen.getByLabelText('@nemtag, phone or account number'), '@kunle');
  expect(await screen.findByText('Kunle Adeyemi')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));

  await at('/send/amount');
  await screen.findByLabelText(/^Available/);
  await tap('7500');
  await fireEvent.changeText(screen.getByLabelText(/What's it for/), 'Suya night');
  const review = screen.getByRole('button', { name: 'Review' });
  await waitFor(() => expect(review).toBeEnabled());
  await fireEvent.press(review);

  await at('/send/review');
  const send = await screen.findByRole('button', { name: /^Send ₦7,500\.00/ });
  await waitFor(() => expect(send).toBeEnabled());
  await fireEvent.press(send);
  await screen.findByText('Enter your PIN');
  await tap(DEMO_PIN);

  await waitFor(() => expect(mockNav.top().path).toMatch(/^\/send\/result\//));
  expect(await screen.findByRole('header', { name: 'Sent' })).toBeTruthy();
  // Replaced, so Back from the result does not return to a spent review screen.
  expect(mockNav.stack.map((r) => r.path)).not.toContain('/send/review');

  const transfer = await repos.transfers.get({ path: { transfer_id: mockNav.top().params.id! } });
  expect(transfer).toMatchObject({ status: 'completed', narration: 'Suya night' });
  // Nem to Nem is free: the wallet goes down by the amount and nothing else.
  expect((await wallet(repos, 'NGN')).minor).toBe(before.minor - 750_000n);
  const latest = (await repos.transactions.list({ query: { limit: 1 } })).data[0]!;
  expect(latest).toMatchObject({ direction: 'debit', amount: { amount_minor: '750000' } });
  await settle();
});

it('convert: holds a rate, converts naira to dollars with the PIN and moves both wallets by the quote', async () => {
  const repos = bank();
  const ngnBefore = await wallet(repos, 'NGN');
  const usdBefore = await wallet(repos, 'USD');
  await open(repos, { '/convert': ConvertRoute }, '/convert');

  await screen.findByLabelText(/^Available/);
  await tap('16000');
  expect(await screen.findByText('Your rate')).toBeTruthy();
  const convert = screen.getByRole('button', { name: 'Convert ₦16,000.00' });
  await waitFor(() => expect(convert).toBeEnabled());
  await fireEvent.press(convert);
  await screen.findByText('Enter your PIN');
  await tap(DEMO_PIN);
  expect(await screen.findByText('Converted')).toBeTruthy();

  const [conversion] = (await repos.fx.listConversions()).data;
  expect(conversion).toMatchObject({
    status: 'completed',
    sell: { currency: 'NGN', amount_minor: '1600000' },
  });
  const bought = BigInt(conversion!.buy.amount_minor);
  expect(bought).toBeGreaterThan(0n);
  expect((await wallet(repos, 'NGN')).minor).toBe(
    ngnBefore.minor - 1_600_000n - BigInt(conversion!.fee.amount_minor),
  );
  expect((await wallet(repos, 'USD')).minor).toBe(usdBefore.minor + bought);
  await settle();
});

it('card freeze: freezes the card, is still frozen after an app restart, then unfreezes', async () => {
  const store = createMemoryStore();
  const repos = bank(store);
  // What a cold start would read: a new bank over the data saved on the phone.
  const afterRestart = async (cardId: string) =>
    (await bank(store).cards.get({ path: { card_id: cardId } })).status;
  await open(repos, { '/cards': CardsRoute }, '/cards');

  const freeze = await screen.findByRole('switch', { name: 'Freeze card' });
  await fireEvent.press(freeze);
  expect(await screen.findByText('Card frozen')).toBeTruthy();
  await waitFor(() => expect(freeze).toBeChecked());
  const card = (await repos.cards.list()).data[0]!;
  expect(card.status).toBe('frozen');
  await settle();
  await waitFor(async () => expect(await afterRestart(card.id)).toBe('frozen'));

  await fireEvent.press(freeze);
  expect(await screen.findByText('Card unfrozen')).toBeTruthy();
  await waitFor(() => expect(freeze).not.toBeChecked());
  await settle();
  await waitFor(async () => expect(await afterRestart(card.id)).toBe('active'));
});

it('ajo contribution: when the turn falls due the contribution is debited through the ledger', async () => {
  useSessionStore.getState().setSession(demoSession());
  const repos = bank();
  const before = await wallet(repos, 'NGN');
  const txnsBefore = new Set(
    (await repos.transactions.list({ query: { limit: 100 } })).data.map((t) => t.id),
  );
  const group = (await repos.ajo.listGroups()).data[0]!;
  const me = await repos.users.getMe();
  const myPaid = async () =>
    (await repos.ajo.listCycles({ path: { group_id: group.id } })).data
      .flatMap((c) => c.contributions)
      .filter((c) => c.member.user_id === me.id && c.status === 'paid').length;
  const paidBefore = await myPaid();

  await open(
    repos,
    {
      '/ajo': AjoListRoute,
      '/ajo/group/[id]': AjoGroupRoute,
      '/demo-controls': DemoControlsRoute,
    },
    '/ajo',
  );
  await fireEvent.press(await screen.findByRole('button', { name: new RegExp(`^${group.name}`) }));
  await at(`/ajo/group/${group.id}`);
  expect(await screen.findByText(/^Turn 2 · \d of \d paid$/)).toBeTruthy();

  // Demo Controls moves the clock a week on, past this turn's due date.
  await act(async () => mockRouter.push('/demo-controls'));
  await fireEvent.press(await screen.findByRole('togglebutton', { name: '7 days' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Jump 7 days ahead' }));
  expect(await screen.findByText(/^Demo date .*, 7 days ahead$/)).toBeTruthy();
  await act(async () => mockRouter.back());
  expect(await screen.findByText(/^Turn 3 · \d of \d paid$/)).toBeTruthy();

  const newlyPaid = (await myPaid()) - paidBefore;
  expect(newlyPaid).toBeGreaterThan(0);

  const fresh = (await repos.transactions.list({ query: { limit: 100 } })).data.filter(
    (t) => !txnsBefore.has(t.id) && t.amount.currency === 'NGN',
  );
  const contributions = fresh.filter((t) => t.type === 'ajo' && t.direction === 'debit');
  expect(contributions).toHaveLength(newlyPaid);
  for (const c of contributions) {
    expect(c).toMatchObject({ direction: 'debit', amount: group.contribution });
  }
  // Double entry: the ledger balance moved by exactly the sum of what was posted to it. (The
  // available balance can differ: a card hold that settles in the week was already held.)
  const posted = fresh.reduce((sum, t) => sum + signed(t), 0n);
  expect((await wallet(repos, 'NGN')).ledger).toBe(before.ledger + posted);
  await settle();
});
