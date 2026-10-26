import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { usePrivacyStore } from '@/stores';
import { ThemeProvider } from '@/theme';

import { goalSubtitle, sortGoals } from '../goals';
import { GrowScreen } from '../screens/GrowScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

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

describe('Grow tab', () => {
  beforeEach(() => usePrivacyStore.setState({ balancesHidden: false }));

  it('shows the total saved, interest earned and the goals', async () => {
    const repos = bank();
    const summary = await repos.savings.getSummary();
    await render(wrap(repos, <GrowScreen />));
    expect(await screen.findByText('Rent 2027')).toBeTruthy();
    expect(screen.getByText('Detty December')).toBeTruthy();
    expect(summary.goals_count).toBe(2);
    expect(screen.getByText(`${summary.goals_count} open · 10% a year`)).toBeTruthy();
    expect(screen.getByText('Interest earned')).toBeTruthy();
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  });

  it('hides amounts with the eye button', async () => {
    await render(wrap(bank(), <GrowScreen />));
    await screen.findByText('Rent 2027');
    await fireEvent.press(screen.getByRole('button', { name: 'Hide balances' }));
    expect(usePrivacyStore.getState().balancesHidden).toBe(true);
    expect(screen.getAllByRole('progressbar')[0]).toHaveProp(
      'accessibilityLabel',
      expect.stringMatching(/^\d+% of the target saved$/),
    );
  });

  it('describes and orders goals', () => {
    const base = {
      id: 'a',
      name: 'A',
      emoji: '🎯',
      target: { amount_minor: '100', currency: 'NGN' },
      balance: { amount_minor: '40', currency: 'NGN' },
      progress_pct: 40,
      target_date: '2027-01-31',
      auto_save: null,
      interest_rate_bps: 1000,
      interest_earned: { amount_minor: '0', currency: 'NGN' },
      status: 'active',
      created_at: '2026-01-01T00:00:00Z',
    } as const;
    expect(goalSubtitle(base)).toBe('40% saved · by 31 Jan 2027');
    expect(goalSubtitle({ ...base, status: 'completed' })).toBe('Target reached');
    const sorted = sortGoals([
      { ...base, id: 'closed', status: 'closed', progress_pct: 90 },
      base,
      { ...base, id: 'b', progress_pct: 70 },
    ]);
    expect(sorted.map((g) => g.id)).toEqual(['b', 'a', 'closed']);
  });
});
