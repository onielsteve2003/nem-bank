import { QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { MASK } from '@/components/MoneyText';
import { problem, repositoriesFromDispatcher, RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { DEFAULT_PREFERENCES, usePreferencesStore, usePrivacyStore } from '@/stores';
import { ThemeProvider } from '@/theme';

import { formatWhen } from '../../transactions/TransactionRow';
import { greetingFor, HomeScreen } from '../HomeScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), canGoBack: () => false }),
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

const NO_GC_TIMERS = {
  defaultOptions: {
    queries: { gcTime: Infinity, retry: false },
    mutations: { gcTime: Infinity },
  },
};
const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

async function renderHome(repos: Repositories) {
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <RepositoryProvider repositories={repos}>
        <QueryProvider client={new QueryClient(NO_GC_TIMERS)}>
          <ThemeProvider initialPreference="dark">
            <HomeScreen />
          </ThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </SafeAreaProvider>,
  );
  // Cards size themselves from layout.
  const carousel = await screen.findByTestId('balance-carousel');
  await fireEvent(carousel, 'layout', { nativeEvent: { layout: { width: 390, height: 200 } } });
}

const tolu = () =>
  createMockRepositories({ store: createMemoryStore(), simulation: { latency: 'off' } });

beforeEach(() => {
  jest.clearAllMocks();
  usePrivacyStore.setState({ balancesHidden: false });
  usePreferencesStore.setState({ ai: { ...DEFAULT_PREFERENCES.ai } });
});

it('greets by the Lagos clock', () => {
  expect(greetingFor(new Date('2026-10-20T07:30:00Z'))).toBe('Good morning'); // 8:30 in Lagos
  expect(greetingFor(new Date('2026-10-20T11:30:00Z'))).toBe('Good afternoon');
  expect(greetingFor(new Date('2026-10-20T16:30:00Z'))).toBe('Good evening');
});

it('says when a transaction happened in Lagos days', () => {
  const now = new Date('2026-10-20T10:00:00Z');
  expect(formatWhen('2026-10-20T08:05:00Z', now)).toMatch(/^Today, /);
  // 23:30 UTC on the 19th is already 00:30 on the 20th in Lagos.
  expect(formatWhen('2026-10-19T23:30:00Z', now)).toMatch(/^Today, /);
  expect(formatWhen('2026-10-19T22:30:00Z', now)).toMatch(/^Yesterday, /);
  expect(formatWhen('2026-10-19T12:00:00Z', now)).toMatch(/^Yesterday, /);
  expect(formatWhen('2026-10-12T12:00:00Z', now)).toBe('12 Oct');
});

it('shows a card per wallet, recent activity, the spending teaser and the assistant', async () => {
  await renderHome(tolu());

  expect(await screen.findByText('Tolu')).toBeOnTheScreen();
  expect(screen.getByText('Demo money')).toBeOnTheScreen();
  expect(screen.getByTestId('balance-NGN')).toBeOnTheScreen();
  expect(screen.getByTestId('balance-USD')).toBeOnTheScreen();
  expect(screen.getByTestId('balance-NGN').props.accessibilityLabel).toMatch(
    /^Nigerian Naira wallet, ending \d{4}\. Available balance ₦[\d,]+\.\d{2}/,
  );
  expect(await screen.findAllByText(/^(Today|Yesterday), |^\d{1,2} \w{3}$/)).toHaveLength(5);
  expect(await screen.findByText(/^Spent in \w+ so far$/)).toBeOnTheScreen();
  expect(screen.getByRole('button', { name: /^Ask Nem Assistant/ })).toBeOnTheScreen();
});

it('hides every amount with one tap, and brings them back', async () => {
  await renderHome(tolu());
  const ngn = await screen.findByTestId('balance-NGN');
  await screen.findAllByText(/^(Today|Yesterday), /);

  await fireEvent.press(screen.getByRole('button', { name: 'Hide balances' }));

  expect(usePrivacyStore.getState().balancesHidden).toBe(true);
  expect(ngn.props.accessibilityLabel).toMatch(/Available balance hidden/);
  expect(within(ngn).getByText(`₦${MASK}`)).toBeOnTheScreen();
  // No digits of any amount are left on screen.
  expect(screen.queryAllByText(/[₦$£€][\d,]+\.\d{2}/)).toHaveLength(0);

  await fireEvent.press(screen.getByRole('button', { name: 'Show balances' }));
  expect(usePrivacyStore.getState().balancesHidden).toBe(false);
});

it('opens each quick action', async () => {
  await renderHome(tolu());
  for (const [name, href] of [
    ['Send', '/send'],
    ['Convert', '/convert'],
    ['Bills', '/pay'],
    ['Scan', '/qr'],
  ] as const) {
    await fireEvent.press(screen.getByRole('button', { name }));
    expect(mockPush).toHaveBeenLastCalledWith(href);
  }
});

it('leaves the assistant out when it is turned off in AI settings', async () => {
  usePreferencesStore.setState({ ai: { ...DEFAULT_PREFERENCES.ai, assistant: false } });
  await renderHome(tolu());
  await screen.findByText('Tolu');
  expect(screen.queryByRole('button', { name: /^Ask Nem Assistant/ })).toBeNull();
});

it('a failed section offers a retry without blanking the rest', async () => {
  const bank = tolu();
  const repos = repositoriesFromDispatcher(async ({ domain, method, input }) => {
    if (domain === 'transactions') throw problem(503, 'offline', 'You are offline');
    const call = (bank[domain] as Record<string, (i: unknown) => Promise<unknown>>)[method]!;
    return call(input);
  });
  await renderHome(repos);
  expect(await screen.findByText("We couldn't load your activity")).toBeOnTheScreen();
  expect(screen.getByTestId('balance-NGN')).toBeOnTheScreen();
});
