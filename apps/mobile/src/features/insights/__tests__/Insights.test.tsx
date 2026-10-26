import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { usePrivacyStore } from '@/stores';
import { ThemeProvider } from '@/theme';

import { changeOf, donutSlices, monthYearLabel, shiftMonth } from '../insights';
import { BudgetsScreen } from '../screens/BudgetsScreen';
import { InsightsScreen } from '../screens/InsightsScreen';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
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
