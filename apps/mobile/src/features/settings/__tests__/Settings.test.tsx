import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { DEFAULT_PREFERENCES, usePreferencesStore, usePrivacyStore } from '@/stores';
import { ThemeProvider } from '@/theme';

import { SettingsScreen } from '../screens/SettingsScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

configure({ defaultIncludeHiddenElements: true });

async function renderSettings(repos: Repositories) {
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <RepositoryProvider repositories={repos}>
        <QueryProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <ThemeProvider initialPreference="dark">
            <ToastProvider>
              <SettingsScreen />
            </ToastProvider>
          </ThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </SafeAreaProvider>,
  );
}

const bank = () =>
  createMockRepositories({
    store: createMemoryStore(),
    clock: () => new Date(),
    simulation: { latency: 'off' },
  });

beforeEach(() => {
  jest.clearAllMocks();
  usePreferencesStore.setState({ ...DEFAULT_PREFERENCES, reduceMotion: 'system' });
  usePrivacyStore.setState({ balancesHidden: false });
});

it('changes theme, privacy mode, auto-lock and low-data mode here and at the bank', async () => {
  const repos = bank();
  await renderSettings(repos);

  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Light' }));
  await fireEvent.press(screen.getByRole('switch', { name: 'Privacy mode' }));
  await fireEvent.press(screen.getByRole('togglebutton', { name: '5 min' }));
  await fireEvent.press(screen.getByRole('switch', { name: 'Low-data mode' }));

  expect(usePreferencesStore.getState()).toMatchObject({
    appearance: 'light',
    autoLockSeconds: 300,
    lowDataMode: true,
  });
  expect(usePrivacyStore.getState().balancesHidden).toBe(true);
  await waitFor(async () =>
    expect(await repos.users.getPreferences()).toMatchObject({
      appearance: 'light',
      auto_lock_seconds: 300,
      low_data_mode: true,
      hide_balances: true,
    }),
  );
});

it('switches the language here and at the bank', async () => {
  const repos = bank();
  await renderSettings(repos);

  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Naija Pidgin' }));

  expect(usePreferencesStore.getState().language).toBe('pcm');
  await waitFor(async () =>
    expect(await repos.users.getPreferences()).toMatchObject({ language: 'pcm' }),
  );
});

it('keeps reduce motion on this phone only', async () => {
  const base = bank();
  const save = jest.fn(base.users.setPreferences);
  await renderSettings({ ...base, users: { ...base.users, setPreferences: save } });
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Always reduce' }));
  expect(usePreferencesStore.getState().reduceMotion).toBe('always');
  expect(save).not.toHaveBeenCalled();
});

it('puts a setting back when the bank does not save it', async () => {
  const base = bank();
  const failing = jest.fn().mockRejectedValue(new Error('offline'));
  await renderSettings({ ...base, users: { ...base.users, setPreferences: failing } });
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Dark' }));
  expect(await screen.findByText("That didn't save. Try again.")).toBeTruthy();
  expect(usePreferencesStore.getState().appearance).toBe('system');
});

it('links to every alert setting', async () => {
  await renderSettings(bank());
  await fireEvent.press(screen.getByRole('button', { name: /^Notifications/ }));
  await fireEvent.press(screen.getByRole('button', { name: /^Security alerts/ }));
  expect(mockPush).toHaveBeenNthCalledWith(1, '/notifications/preferences');
  expect(mockPush).toHaveBeenNthCalledWith(2, '/security/alerts');
});
