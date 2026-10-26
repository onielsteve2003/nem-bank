import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories, DEMO_PIN } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { usePrivacyStore } from '@/stores';
import { ThemeProvider } from '@/theme';

import { goalSubtitle, sortGoals } from '../goals';
import { GoalScreen } from '../screens/GoalScreen';
import { GrowScreen } from '../screens/GrowScreen';
import { NewGoalScreen, targetDateError } from '../screens/NewGoalScreen';
import { keptOnBreak } from '../locks';
import { LockScreen } from '../screens/LockScreen';
import { roundUpExample, RoundUpsScreen } from '../screens/RoundUpsScreen';

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: jest.fn() }),
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

describe('savings goals', () => {
  beforeEach(() => {
    usePrivacyStore.setState({ balancesHidden: false });
    mockPush.mockClear();
    mockReplace.mockClear();
  });

  const pin = async () => {
    for (const digit of DEMO_PIN) {
      await fireEvent.press((await screen.findAllByRole('button', { name: digit })).at(-1)!);
    }
  };
  const typeAmount = async (keys: string) => {
    for (const key of keys) {
      await fireEvent.press(screen.getAllByRole('button', { name: key })[0]!);
    }
  };

  it('creates a goal with an emoji, target, date and auto-save', async () => {
    const repos = bank();
    await render(wrap(repos, <NewGoalScreen />));
    await fireEvent.changeText(screen.getByLabelText('What are you saving for?'), 'New laptop');
    await fireEvent.press(screen.getByRole('radio', { name: '🎓' }));
    await typeAmount('500000');
    await fireEvent.changeText(screen.getByLabelText('Reach it by (optional)'), '31/12/2030');
    await fireEvent.press(screen.getByRole('switch', { name: /Auto-save/ }));
    await fireEvent.press(screen.getByRole('togglebutton', { name: '₦10,000' }));
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Every month' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create goal' })).not.toBeDisabled(),
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Create goal' }));
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());

    const created = (await repos.savings.listGoals()).data.find((g) => g.name === 'New laptop');
    expect(created).toMatchObject({
      emoji: '🎓',
      target: { amount_minor: '50000000', currency: 'NGN' },
      target_date: '2030-12-31',
      auto_save: { amount: { amount_minor: '1000000', currency: 'NGN' }, frequency: 'monthly' },
    });
  });

  it('refuses a target date in the past', () => {
    expect(targetDateError('01/01/2020', '2026-10-26')).toBe('Pick a day after today');
    expect(targetDateError('31/02/2027', '2026-10-26')).toBe('Use a real date in DD/MM/YYYY');
    expect(targetDateError('01/01/2027', '2026-10-26')).toBeNull();
  });

  it('adds money, then withdraws with the PIN', async () => {
    const repos = bank();
    const goal = (await repos.savings.listGoals()).data.find((g) => g.name === 'Rent 2027')!;
    await render(wrap(repos, <GoalScreen id={goal.id} />));
    expect(await screen.findByText('Rent 2027', { exact: false })).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Add money' }));
    await typeAmount('1000');
    await fireEvent.press(await screen.findByRole('button', { name: 'Add ₦1,000' }));
    await waitFor(async () =>
      expect(
        (await repos.savings.getGoal({ path: { goal_id: goal.id } })).balance.amount_minor,
      ).toBe(String(BigInt(goal.balance.amount_minor) + 100_000n)),
    );

    await fireEvent.press(await screen.findByRole('button', { name: 'Withdraw' }));
    await typeAmount('500');
    await fireEvent.press(await screen.findByRole('button', { name: 'Withdraw ₦500' }));
    await pin();
    await waitFor(async () =>
      expect(
        (await repos.savings.getGoal({ path: { goal_id: goal.id } })).balance.amount_minor,
      ).toBe(String(BigInt(goal.balance.amount_minor) + 50_000n)),
    );
  });

  it('changes round-ups and saves each change straight away', async () => {
    const repos = bank();
    expect(roundUpExample('50000')).toBe('A ₦1,230.00 spend saves ₦270.00');
    await render(wrap(repos, <RoundUpsScreen />));
    expect(await screen.findByText('Round up my spending')).toBeTruthy();
    await fireEvent.press(screen.getByText('₦1,000'));
    await waitFor(async () => expect((await repos.savings.getRoundUps()).round_to).toBe('100000'));
    await fireEvent.press(screen.getByText('Transfers'));
    await waitFor(async () =>
      expect((await repos.savings.getRoundUps()).sources).toEqual(['card', 'transfer']),
    );
    await fireEvent.press(screen.getByText('Round up my spending'));
    await waitFor(async () => expect((await repos.savings.getRoundUps()).enabled).toBe(false));
    expect(screen.getByText(/No round-ups yet/)).toBeTruthy();
  });

  it('keeps half the interest, rounded up, when a lock breaks early', () => {
    const lock = { early_break_penalty_bps: 5_000 } as Parameters<typeof keptOnBreak>[0];
    expect(keptOnBreak(lock, { amount: 1_001n, currency: 'NGN' }).amount).toBe(501n);
  });

  it('spells out what breaking a lock early costs before the PIN', async () => {
    const repos = bank();
    const lock = (await repos.savings.listLocks()).data[0]!;
    await render(wrap(repos, <LockScreen id={lock.id} />));
    expect(await screen.findByText('14% a year, fixed')).toBeTruthy();
    await fireEvent.press(screen.getByText('Break lock early'));
    expect(await screen.findByText('Break this lock early?')).toBeTruthy();
    expect(screen.getByText(/You lose .* of interest earned so far/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Break lock' }));
    await pin();
    await waitFor(async () =>
      expect((await repos.savings.getLock({ path: { lock_id: lock.id } })).status).toBe('broken'),
    );
  });
});
