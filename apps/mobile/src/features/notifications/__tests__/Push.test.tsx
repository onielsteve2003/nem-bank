import type { RealtimeEvent, Schema } from '@nem/contracts';
import { QueryClient } from '@tanstack/react-query';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components';
import { RepositoryProvider, type RealtimeSource, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import * as push from '@/lib/pushNotifications';
import { QueryProvider } from '@/lib/query';
import { useSessionStore } from '@/stores';
import { ThemeProvider } from '@/theme';

import { PhoneAlertsCard } from '../components/PhoneAlertsCard';
import { PushBridge } from '../components/PushBridge';
import { phoneAlertStatus, raisesLocally, usePushStore, wantsPush } from '../push';

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn(), back: jest.fn() }),
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

let mockOpened: ((alert: push.OpenedAlert) => void) | undefined;
jest.mock('@/lib/pushNotifications', () => ({
  getPushSupport: jest.fn(() => 'push'),
  getPushPermission: jest.fn(async () => 'granted'),
  requestPushPermission: jest.fn(async () => 'granted'),
  getPushToken: jest.fn(async () => 'ExponentPushToken[abc]'),
  configureAlerts: jest.fn(),
  showLocalAlert: jest.fn(async () => undefined),
  onAlertOpened: jest.fn((open) => {
    mockOpened = open;
    return () => undefined;
  }),
}));
const mocked = jest.mocked(push);

configure({ defaultIncludeHiddenElements: true });

const prefsWith = (on: boolean): Schema<'NotificationPreferences'> => {
  const ch = { in_app: true, push: on, email: false };
  return {
    categories: {
      transactions: ch,
      security: ch,
      savings: ch,
      ajo: ch,
      credit: ch,
      support: ch,
      product: ch,
      marketing: { in_app: true, push: false, email: false },
    },
  };
};

describe('phone alert rules', () => {
  it('raises alerts itself unless the bank can push to this phone', () => {
    expect(raisesLocally('mock', 'ExponentPushToken[a]')).toBe(true);
    expect(raisesLocally('http', null)).toBe(true);
    expect(raisesLocally('http', 'ExponentPushToken[a]')).toBe(false);
  });

  it('follows the push switch for each category, and stays quiet before settings load', () => {
    expect(wantsPush(undefined, 'transactions')).toBe(false);
    expect(wantsPush(prefsWith(true), 'transactions')).toBe(true);
    expect(wantsPush(prefsWith(true), 'marketing')).toBe(false);
  });

  it('says what this phone can do, with one next step', () => {
    expect(phoneAlertStatus('none', 'denied').action).toBeNull();
    expect(phoneAlertStatus('push', 'undetermined').action).toBe('enable');
    expect(phoneAlertStatus('push', 'unknown').action).toBe('enable');
    expect(phoneAlertStatus('push', 'denied').action).toBe('settings');
    expect(phoneAlertStatus('push', 'granted')).toMatchObject({ tone: 'success', action: 'test' });
    expect(phoneAlertStatus('localOnly', 'granted').detail).toMatch(/Expo Go on Android/);
  });
});

describe('PushBridge', () => {
  const listeners = new Set<(e: RealtimeEvent) => void>();
  const realtime: RealtimeSource = {
    subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    status: () => 'open',
    onStatus: () => () => undefined,
  };
  const emit = (n: Schema<'Notification'>) =>
    act(() => {
      for (const l of listeners)
        l({ id: 'e1', type: 'notification.created', occurred_at: n.created_at, data: n });
    });
  const note: Schema<'Notification'> = {
    id: 'n1',
    category: 'transactions',
    title: 'Money in',
    body: 'Amaka sent you ₦5,000',
    read: false,
    deep_link: 'nembank://transactions',
    created_at: new Date().toISOString(),
  };

  let repos: Repositories;
  let register: jest.Mock;
  let deviceId: string;
  beforeEach(async () => {
    jest.clearAllMocks();
    usePushStore.setState({ permission: 'unknown', registeredToken: null });
    const real = createMockRepositories({
      store: createMemoryStore(),
      clock: () => new Date(),
      simulation: { latency: 'off' },
    });
    register = jest.fn(real.notifications.registerPushToken);
    repos = { ...real, notifications: { ...real.notifications, registerPushToken: register } };
    deviceId = (await repos.devices.list()).data[0]!.id;
    useSessionStore.setState({ session: { deviceId } as never });
  });

  const renderBridge = (ui: React.ReactElement = <PushBridge />) =>
    render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        <RepositoryProvider repositories={repos} realtime={realtime}>
          <QueryProvider
            client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
          >
            <ThemeProvider initialPreference="dark">
              <ToastProvider>{ui}</ToastProvider>
            </ThemeProvider>
          </QueryProvider>
        </RepositoryProvider>
      </SafeAreaProvider>,
    );

  it('registers this phone with the bank and alerts for a new payment', async () => {
    await repos.notifications.setPreferences({ body: prefsWith(true) });
    await renderBridge();
    await waitFor(() =>
      expect(usePushStore.getState().registeredToken).toBe('ExponentPushToken[abc]'),
    );
    expect(register).toHaveBeenCalledWith({
      body: { device_id: deviceId, expo_push_token: 'ExponentPushToken[abc]' },
    });

    // The demo bank has no push server, so the app raises the alert itself.
    await waitFor(() => expect(listeners.size).toBeGreaterThan(0));
    await emit(note);
    await waitFor(() =>
      expect(mocked.showLocalAlert).toHaveBeenCalledWith({
        id: 'n1',
        title: 'Money in',
        body: 'Amaka sent you ₦5,000',
        deepLink: 'nembank://transactions',
      }),
    );
  });

  it('stays quiet when push is off for the category', async () => {
    await repos.notifications.setPreferences({ body: prefsWith(false) });
    await renderBridge();
    await waitFor(() => expect(usePushStore.getState().permission).toBe('granted'));
    await emit(note);
    expect(mocked.showLocalAlert).not.toHaveBeenCalled();
  });

  it('opens the screen an alert is about and marks it read', async () => {
    const unread = async () =>
      (await repos.notifications.list({ query: { unread_only: true } })).data;
    const first = (await unread())[0]!;
    await renderBridge();
    await act(() => mockOpened!({ id: first.id, deepLink: 'nembank://transactions' }));
    expect(mockRouterPush).toHaveBeenCalled();
    await waitFor(async () => expect((await unread()).some((n) => n.id === first.id)).toBe(false));
  });

  it('asks for permission from the settings card', async () => {
    mocked.getPushPermission.mockResolvedValueOnce('undetermined');
    await renderBridge(
      <>
        <PushBridge />
        <PhoneAlertsCard />
      </>,
    );
    await fireEvent.press(await screen.findByRole('button', { name: 'Turn on alerts' }));
    expect(mocked.requestPushPermission).toHaveBeenCalled();
    expect(await screen.findByText('Alerts are on for this phone')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Send a test alert' }));
    expect(mocked.showLocalAlert).toHaveBeenCalled();
  });
});
