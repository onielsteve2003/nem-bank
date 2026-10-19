import type { AuthSession } from '@nem/contracts';
import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { useSessionStore } from '@/stores';
import { ThemeProvider } from '@/theme';

import { ChooseNemtagScreen } from '../screens/ChooseNemtagScreen';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), canGoBack: () => false }),
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

let repos: Repositories;

async function renderScreen() {
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <RepositoryProvider repositories={repos}>
        <QueryProvider client={new QueryClient(NO_GC_TIMERS)}>
          <ThemeProvider initialPreference="dark">
            <ChooseNemtagScreen />
          </ThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </SafeAreaProvider>,
  );
}

const field = () => screen.getByLabelText('@nemtag');
const claim = () => screen.getByRole('button', { name: /^Claim @/ });

beforeEach(() => {
  repos = createMockRepositories({ store: createMemoryStore(), simulation: { latency: 'off' } });
  useSessionStore.getState().setSession({
    access_token: 'a',
    access_token_expires_at: '2099-01-01T00:00:00Z',
    refresh_token: 'r',
    refresh_token_expires_at: '2099-01-01T00:00:00Z',
    token_type: 'Bearer',
    user: { id: 'u1', is_demo: false, nemtag: null },
    device: { id: 'd1', cool_off_until: null },
  } as unknown as AuthSession);
});

it('starts the session on the chooser when the account has no @nemtag', () => {
  expect(useSessionStore.getState().session?.needsNemtag).toBe(true);
});

it('offers ideas from the customer’s name before anything is typed', async () => {
  await renderScreen();
  expect(await screen.findByRole('button', { name: '@tolulope' })).toBeOnTheScreen();
  expect(claim()).toBeDisabled();
});

it('explains a bad shape at once, without asking the bank', async () => {
  const check = jest.fn(repos.users.checkNemtag);
  repos = { ...repos, users: { ...repos.users, checkNemtag: check } };
  await renderScreen();
  await fireEvent.changeText(field(), '2pac');
  expect(screen.getByText('Start with a letter')).toBeOnTheScreen();
  await act(() => new Promise((done) => setTimeout(done, 500)));
  expect(check).not.toHaveBeenCalled();
  expect(claim()).toBeDisabled();
});

it('says a tag is taken, offers free ones, and claims the one picked', async () => {
  await renderScreen();
  await fireEvent.changeText(field(), '@Emeka');

  expect(await screen.findByText('@emeka is taken')).toBeOnTheScreen();
  await fireEvent.press(await screen.findByRole('button', { name: '@emeka_ng' }));
  expect(await screen.findByText('@emeka_ng is yours if you want it')).toBeOnTheScreen();

  await fireEvent.press(screen.getByRole('button', { name: 'Claim @emeka_ng' }));

  await waitFor(() => expect(useSessionStore.getState().session?.needsNemtag).toBe(false));
  expect((await repos.users.getMe()).nemtag).toBe('emeka_ng');
});
