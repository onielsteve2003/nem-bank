import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { usePreferencesStore, usePrivacyStore } from '@/stores';
import { ThemeProvider } from '@/theme';

import { changeOf, donutSlices, monthYearLabel, shiftMonth } from '../insights';
import { firstShortfall, horizon } from '../forecast';
import { BudgetsScreen } from '../screens/BudgetsScreen';
import { ForecastScreen } from '../screens/ForecastScreen';
import { InsightsScreen } from '../screens/InsightsScreen';
import { SubscriptionsScreen } from '../screens/SubscriptionsScreen';
import { daysUntil, nextChargeLabel, paidWith } from '../subscriptions';

const mockDismissTo = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    dismissTo: mockDismissTo,
  }),
  useLocalSearchParams: () => ({}),
}));

configure({ defaultIncludeHiddenElements: true });

const bank = () =>
  createMockRepositories({
    store: createMemoryStore(),
    clock: () => new Date(Date.now()),
    simulation: { latency: 'off' },
  });

const wrap = (repos: Repositories, ui: React.ReactElement = <InsightsScreen />) => (
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

const spend = (category: string, now: number, before = 0) => ({
  category: category as 'food',
  amount: { amount_minor: String(now), currency: 'NGN' as const },
  previous_amount: { amount_minor: String(before), currency: 'NGN' as const },
  share_pct: 0,
});

describe('insights helpers', () => {
  it('steps months across a year boundary', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2025-12', 1)).toBe('2026-01');
    expect(shiftMonth('2026-10', -5)).toBe('2026-05');
  });

  it('folds everything past the fourth category into one slice', () => {
    const slices = donutSlices(
      ['food', 'transport', 'groceries', 'shopping', 'health', 'education'].map((c, i) =>
        spend(c, 600 - i * 100),
      ),
    );
    expect(slices.map((s) => s.label)).toEqual([
      'Food & drink',
      'Transport',
      'Groceries',
      'Shopping',
      'Everything else',
    ]);
    expect(slices.at(-1)!.minor).toBe(300n);
  });

  it('never calls a month in progress cheaper than a whole month', () => {
    expect(changeOf(500n, 800n, true)).toEqual({ kind: 'same' });
    expect(changeOf(500n, 800n, false)).toEqual({ kind: 'less', minor: 300n });
    expect(changeOf(900n, 800n, true)).toEqual({ kind: 'more', minor: 100n });
    expect(changeOf(900n, 0n, false)).toEqual({ kind: 'new' });
  });
});

describe('insights screen', () => {
  beforeEach(() => usePrivacyStore.setState({ balancesHidden: false }));

  it('shows this month by category against last month, and steps back a month', async () => {
    await render(wrap(bank()));
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    expect(await screen.findByText(monthYearLabel(thisMonth))).toBeTruthy();
    expect(screen.getByLabelText(/^Spending by category in /)).toBeTruthy();
    expect(screen.getByText(/^Compared with /)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: `Show ${monthYearLabel(shiftMonth(thisMonth, 1))}` }),
    ).toBeDisabled();

    fireEvent.press(
      screen.getByRole('button', { name: `Show ${monthYearLabel(shiftMonth(thisMonth, -1))}` }),
    );
    expect(await screen.findByText(monthYearLabel(shiftMonth(thisMonth, -1)))).toBeTruthy();
    expect(await screen.findByText('You spent')).toBeTruthy();
  });

  it('hides amounts when balances are hidden', async () => {
    usePrivacyStore.setState({ balancesHidden: true });
    await render(wrap(bank()));
    expect(await screen.findAllByLabelText(/: hidden, \d+% of spending/)).not.toHaveLength(0);
  });
});

describe('budgets', () => {
  beforeEach(() => usePrivacyStore.setState({ balancesHidden: false }));

  const typeAmount = async (keys: string) => {
    for (const key of keys) {
      await fireEvent.press(screen.getAllByRole('button', { name: key })[0]!);
    }
  };

  it('shows this month’s budgets on Insights', async () => {
    await render(wrap(bank()));
    expect(await screen.findByLabelText(/^Food & drink budget, /)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manage, Budgets' })).toBeTruthy();
  });

  it('adds a budget, changes it and removes it', async () => {
    const repos = bank();
    await render(wrap(repos, <BudgetsScreen />));
    expect(await screen.findByLabelText(/^Transport budget, /)).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Add a budget' }));
    await fireEvent.press(await screen.findByText('Groceries'));
    await typeAmount('500');
    expect(await screen.findByText('Set at least ₦1,000')).toBeTruthy();
    await typeAmount('00');
    await fireEvent.press(screen.getByRole('button', { name: 'Add groceries budget' }));
    const groceries = await screen.findByLabelText(/^Groceries budget, .* of ₦50,000\.00 spent/);

    await fireEvent.press(groceries);
    await fireEvent.press(await screen.findByRole('button', { name: 'Remove budget' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(async () =>
      expect((await repos.insights.listBudgets()).data.map((b) => b.category)).not.toContain(
        'groceries',
      ),
    );
  }, 20_000);
});

describe('cash-flow forecast', () => {
  beforeEach(() => usePrivacyStore.setState({ balancesHidden: false }));

  const point = (date: string, naira: number) => {
    const m = { amount_minor: String(naira * 100), currency: 'NGN' as const };
    return { date, balance: m, low: m, high: m };
  };

  it('plans around the day before payday and finds the first shortfall', () => {
    const points = [
      point('2026-11-23', 5_000),
      point('2026-11-24', -1_000),
      point('2026-11-25', 200_000),
      point('2026-11-26', 190_000),
    ];
    expect(horizon(points, '2026-11-25')!.date).toBe('2026-11-24');
    expect(horizon(points, null)!.date).toBe('2026-11-26');
    expect(firstShortfall(points)!.date).toBe('2026-11-24');
    expect(firstShortfall(points.slice(2))).toBeUndefined();
  });

  it('shows the forecast, the why and what is expected', async () => {
    usePreferencesStore.getState().setAiFeature('forecast', true);
    await render(wrap(bank(), <ForecastScreen />));
    expect(await screen.findByLabelText(/^Forecast naira balance, day by day\./)).toBeTruthy();
    expect(screen.getByText(/^You spend about ₦/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'AI: Cash-flow forecast' })).toBeTruthy();
    expect(screen.getByText(/^Likely between ₦/)).toBeTruthy();
  });

  it('says it is a simple average when the AI forecast is off', async () => {
    usePreferencesStore.getState().setAiFeature('forecast', false);
    await render(wrap(bank(), <ForecastScreen />));
    expect(await screen.findByText('AI forecast is off · simple average')).toBeTruthy();
  });
});

describe('subscriptions', () => {
  beforeEach(() => {
    usePrivacyStore.setState({ balancesHidden: false });
    mockDismissTo.mockClear();
  });

  const sub = (card_id: string | null) => ({
    id: 's1',
    merchant: 'Netflix',
    amount: { amount_minor: '700000', currency: 'NGN' as const },
    frequency: 'monthly' as const,
    last_charged_at: '2026-10-03T09:00:00Z',
    next_expected_at: '2026-11-02',
    card_id,
  });

  it('counts the days to the next charge and says when it is due', () => {
    expect(daysUntil('2026-11-02', '2026-10-27')).toBe(6);
    expect(nextChargeLabel('2026-11-02', '2026-10-27')).toBe('Next charge Mon, 2 Nov (in 6 days)');
    expect(nextChargeLabel('2026-10-28', '2026-10-27')).toBe('Next charge tomorrow');
    expect(nextChargeLabel('2026-10-27', '2026-10-27')).toBe('Next charge today');
    expect(nextChargeLabel('2026-10-20', '2026-10-27')).toMatch(/^Was due /);
  });

  it('warns when the card that pays is frozen, and falls back to the wallet with no card', () => {
    const card = { id: 'c1', last4: '4321', status: 'frozen', type: 'standard', nickname: null };
    const frozen = paidWith(sub('c1'), [card as never]);
    expect(frozen).toMatchObject({ kind: 'card', label: 'Standard card ending 4321' });
    expect(frozen.kind === 'card' && frozen.warning).toMatch(/frozen/);
    expect(paidWith(sub(null), []).kind).toBe('wallet');
  });

  it('lists seeded subscriptions with a monthly total and links to the paying card', async () => {
    await render(wrap(bank(), <SubscriptionsScreen />));
    expect(await screen.findByText('Netflix')).toBeTruthy();
    expect(screen.getByText('Spotify')).toBeTruthy();
    expect(screen.getByText('DStv Compact')).toBeTruthy();
    expect(screen.getByLabelText(/^Subscriptions a month/)).toBeTruthy();
    const controls = await screen.findAllByRole('button', { name: 'Card controls' });
    fireEvent.press(controls[0]!);
    expect(mockDismissTo).toHaveBeenCalledWith({
      pathname: '/cards',
      params: { card: expect.any(String) },
    });
  });

  it('shows a subscriptions card on Insights', async () => {
    await render(wrap(bank()));
    expect(await screen.findByLabelText(/^\d+ subscriptions, ₦[\d,.]+ a month\./)).toBeTruthy();
  });
});
