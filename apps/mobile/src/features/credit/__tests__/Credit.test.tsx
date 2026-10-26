import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { usePreferencesStore } from '@/stores';
import { ThemeProvider } from '@/theme';

import { amountAt, amountSteps, nextStep, sortReasons, tenorLabel } from '../credit';
import { CreditScreen } from '../screens/CreditScreen';
import { OfferScreen } from '../screens/OfferScreen';

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

const wrap = (repos: Repositories, ui: React.ReactElement = <CreditScreen />) => (
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

describe('credit hub', () => {
  beforeEach(() => usePreferencesStore.getState().setAiFeature('creditScoring', true));

  it('shows how much the demo customer can borrow and why', async () => {
    await render(wrap(bank()));
    expect(await screen.findByText('You can borrow up to')).toBeTruthy();
    expect(screen.getByLabelText(/^Credit score band: (Fair|Good), \d of 4$/)).toBeTruthy();
    expect(screen.getByLabelText('Helps: Your salary arrives on time every month.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'AI: Credit scoring' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
  });

  it('says it used the standard rules when AI scoring is off', async () => {
    usePreferencesStore.getState().setAiFeature('creditScoring', false);
    await render(wrap(bank()));
    expect(await screen.findByText('AI scoring is off · standard check')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'AI: Credit scoring' })).toBeNull();
  });

  it('points to the next step from the reason codes', () => {
    const reasons = [
      { code: 'active_loan', impact: 'negative' as const, message: 'Repay first' },
      { code: 'regular_salary', impact: 'positive' as const, message: 'Salary' },
      { code: 'kyc_tier', impact: 'negative' as const, message: 'Tier 3' },
    ];
    expect(sortReasons(reasons)[0]!.code).toBe('regular_salary');
    expect(nextStep(reasons)).toBe('kyc');
    expect(nextStep(reasons.slice(0, 2))).toBe('repay');
    expect(nextStep([])).toBeNull();
  });
});

describe('loan offer', () => {
  it('discloses APR, interest, fee, total and the schedule, and re-prices on change', async () => {
    await render(wrap(bank(), <OfferScreen />));
    const amount = await screen.findByRole('adjustable', { name: 'Amount to borrow' });
    expect(await screen.findByText('APR')).toBeTruthy();
    expect(screen.getByText('28% a year')).toBeTruthy();
    expect(screen.getByText('Total to repay')).toBeTruthy();
    expect(screen.getAllByLabelText(/^Payment \d,/)).toHaveLength(3);

    const tenor = screen.getByRole('adjustable', { name: 'Repay over' });
    await fireEvent(tenor, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(await screen.findByText('30% a year', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getAllByLabelText(/^Payment \d,/)).toHaveLength(6);
    expect(amount.props.accessibilityValue.text).toMatch(/^₦[\d,]+$/);
  });

  it('opens from the hub when the customer can borrow', async () => {
    await render(wrap(bank()));
    await fireEvent.press(await screen.findByRole('button', { name: 'See your offer' }));
    expect(mockPush).toHaveBeenCalledWith('/credit/offer');
  });

  it('steps amounts by ₦5,000 and labels tenors in months', () => {
    expect(amountSteps(1_250_000n)).toBe(2);
    expect(amountAt(0)).toBe(500_000n);
    expect(amountAt(9)).toBe(5_000_000n);
    expect(tenorLabel(30)).toBe('1 month');
    expect(tenorLabel(180)).toBe('6 months');
  });
});
