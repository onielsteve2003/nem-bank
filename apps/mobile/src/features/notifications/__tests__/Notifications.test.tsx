import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { groupByDay, setChannel } from '../notifications';
import { NotificationPreferencesScreen } from '../screens/NotificationPreferencesScreen';
import { NotificationsScreen } from '../screens/NotificationsScreen';

const mockPush = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: mockBack }),
  useLocalSearchParams: () => ({}),
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

configure({ defaultIncludeHiddenElements: true });

const bank = () =>
  createMockRepositories({
    store: createMemoryStore(),
    clock: () => new Date(),
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

const note = (id: string, created_at: string) => ({
  id,
  category: 'transactions' as const,
  title: id,
  body: '',
  read: false,
  deep_link: 'nembank://home',
  created_at,
});

describe('notification rules', () => {
  it('groups by the Lagos day', () => {
    const now = Date.parse('2026-11-02T10:00:00Z');
    const groups = groupByDay(
      [
        note('a', '2026-11-01T23:30:00Z'), // 00:30 on 2 Nov in Lagos
        note('b', '2026-11-01T22:30:00Z'), // 23:30 on 1 Nov
        note('c', '2026-10-20T10:00:00Z'),
      ],
      now,
    );
    expect(groups.map((g) => [g.title, g.items.map((n) => n.id)])).toEqual([
      ['Today', ['a']],
      ['This week', ['b']],
      ['Earlier', ['c']],
    ]);
  });

  it('never turns security alerts off in the app', () => {
    const prefs = {
      categories: { security: { in_app: true, push: true, email: true } },
    } as never;
    expect(setChannel(prefs, 'security', 'in_app', false)).toBe(prefs);
    expect(setChannel(prefs, 'security', 'push', false).categories.security.push).toBe(false);
  });
});

describe('NotificationsScreen', () => {
  it('shows the inbox, opens a notification and marks it read', async () => {
    const repos = bank();
    await render(wrap(repos, <NotificationsScreen />));
    const request = await screen.findByText('Amaka requested ₦7,500.00');
    expect(screen.getByText('Today')).toBeOnTheScreen();
    expect(screen.getByRole('togglebutton', { name: 'Unread (2)' })).toBeOnTheScreen();

    await fireEvent.press(request);
    expect(mockPush).toHaveBeenCalledWith('/send/requests');
    await waitFor(async () => expect((await repos.notifications.list()).unread_count).toBe(1));
  });

  it('closes, since a full-screen modal has no swipe to dismiss', async () => {
    await render(wrap(bank(), <NotificationsScreen />));
    await fireEvent.press(await screen.findByRole('button', { name: 'Close' }));
    expect(mockBack).toHaveBeenCalled();
  });

  it('marks everything read and shows the caught-up state', async () => {
    const repos = bank();
    await render(wrap(repos, <NotificationsScreen />));
    await screen.findByText('Amaka requested ₦7,500.00');
    await fireEvent.press(screen.getByRole('button', { name: 'Mark all as read' }));
    await waitFor(async () => expect((await repos.notifications.list()).unread_count).toBe(0));
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Unread' }));
    expect(await screen.findByText('All caught up')).toBeOnTheScreen();
  });
});

describe('NotificationPreferencesScreen', () => {
  it('saves a switch at once, keeps security in the app, and stops muted categories', async () => {
    const repos = bank();
    await render(wrap(repos, <NotificationPreferencesScreen />));
    const security = await screen.findByRole('switch', { name: 'Security: In the app' });
    expect(security).toBeDisabled();
    const offers = screen.getByRole('switch', { name: 'Offers: Push' });
    expect(offers).not.toBeChecked();

    await fireEvent.press(screen.getByRole('switch', { name: 'Ajo: In the app' }));
    await waitFor(async () =>
      expect((await repos.notifications.getPreferences()).categories.ajo.in_app).toBe(false),
    );
  });
});
