import { QueryClient } from '@tanstack/react-query';
import { configure, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { usePreferencesStore } from '@/stores';
import { ThemeProvider } from '@/theme';

import { nextStep, sortReasons } from '../credit';
import { CreditScreen } from '../screens/CreditScreen';

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

const wrap = (repos: Repositories) => (
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
            <ModalSheetHost>
              <CreditScreen />
            </ModalSheetHost>
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
