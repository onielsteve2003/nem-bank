import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { DEFAULT_PREFERENCES, usePreferencesStore } from '@/stores';
import { ThemeProvider } from '@/theme';

import { AI_FEATURES } from '../aiFeatures';
import { AiTransparencyScreen } from '../screens/AiTransparencyScreen';
import { ModelCardScreen } from '../screens/ModelCardScreen';

const mockPush = jest.fn();
const mockParams: { feature?: string } = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

configure({ defaultIncludeHiddenElements: true });

const wrap = (repos: Repositories, ui: React.ReactElement) => (
  <SafeAreaProvider
    initialMetrics={{
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 47, left: 0, right: 0, bottom: 34 },
    }}
  >
    <RepositoryProvider repositories={repos}>
      <QueryProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider initialPreference="dark">
          <ToastProvider>{ui}</ToastProvider>
        </ThemeProvider>
      </QueryProvider>
    </RepositoryProvider>
  </SafeAreaProvider>
);

const bank = () =>
  createMockRepositories({
    store: createMemoryStore(),
    clock: () => new Date(),
    simulation: { latency: 'off' },
  });

beforeEach(() => {
  jest.clearAllMocks();
  usePreferencesStore.setState({ ai: { ...DEFAULT_PREFERENCES.ai } });
});

describe('AI feature catalogue', () => {
  it('gives every feature its data, a fallback and a model card with a baseline', () => {
    for (const f of AI_FEATURES) {
      expect(f.uses.length).toBeGreaterThan(0);
      expect(f.neverUses.length).toBeGreaterThan(0);
      expect(f.fallback).not.toBe('');
      expect(f.card.data.length).toBeGreaterThan(0);
      expect(f.card.baseline).not.toBe('');
      expect(f.card.limitations.length).toBeGreaterThan(0);
    }
  });

  it('has a switch for every AI setting', () => {
    const toggles = AI_FEATURES.map((f) => f.toggle).filter(Boolean);
    expect(toggles.sort()).toEqual(Object.keys(DEFAULT_PREFERENCES.ai).sort());
  });
});

describe('AiTransparencyScreen', () => {
  it('turns a feature off on the phone and at the bank, and keeps fraud protection on', async () => {
    const repos = bank();
    await render(wrap(repos, <AiTransparencyScreen />));
    expect(screen.getByRole('switch', { name: 'Use AI for Fraud protection' })).toBeDisabled();

    await fireEvent(
      screen.getByRole('switch', { name: 'Use AI for Cash-flow forecast' }),
      'valueChange',
      false,
    );
    expect(usePreferencesStore.getState().ai.forecast).toBe(false);
    expect(await screen.findByText(/Off · A simple average/)).toBeOnTheScreen();
    await waitFor(async () => expect((await repos.users.getPreferences()).ai.forecast).toBe(false));
  });

  it('opens a model card', async () => {
    await render(wrap(bank(), <AiTransparencyScreen />));
    await fireEvent.press(screen.getByText('Scam checker'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/ai/[feature]',
      params: { feature: 'scam-checker' },
    });
  });
});

describe('ModelCardScreen', () => {
  it('shows what the feature uses, never uses, its data and limits', async () => {
    mockParams.feature = 'scam-checker';
    await render(wrap(bank(), <ModelCardScreen />));
    expect(screen.getByText('Only the text you paste in')).toBeOnTheScreen();
    expect(screen.getByText('UCI SMS Spam Collection (CC BY 4.0)')).toBeOnTheScreen();
    expect(screen.getByText('The on-device rules alone')).toBeOnTheScreen();
    expect(screen.getByText(/claims no accuracy/)).toBeOnTheScreen();
  });

  it('says so when the feature does not exist', async () => {
    mockParams.feature = 'nope';
    await render(wrap(bank(), <ModelCardScreen />));
    expect(screen.getByText("We can't find that feature")).toBeOnTheScreen();
  });
});
