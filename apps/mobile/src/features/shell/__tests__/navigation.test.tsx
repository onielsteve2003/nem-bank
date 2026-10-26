import type { AuthSession } from '@nem/contracts';
import { QueryClient } from '@tanstack/react-query';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { redirectSystemPath } from '../../../../app/+native-intent';
import AppLayout, { unstable_settings as appSettings } from '../../../../app/(app)/_layout';
import AjoInviteRoute from '../../../../app/(app)/ajo/[code]';
import CardsRoute from '../../../../app/(app)/(tabs)/cards';
import GrowRoute from '../../../../app/(app)/(tabs)/grow';
import HomeRoute from '../../../../app/(app)/(tabs)/home';
import MeRoute from '../../../../app/(app)/(tabs)/me';
import PayRoute from '../../../../app/(app)/(tabs)/pay';
import TabsLayout from '../../../../app/(app)/(tabs)/_layout';
import ConvertRoute from '../../../../app/(app)/convert/index';
import ConvertLayout from '../../../../app/(app)/convert/_layout';
import DemoControlsRoute from '../../../../app/(app)/demo-controls';
import PaymentLinkRoute from '../../../../app/pay/[slug]';
import AssistantRoute from '../../../../app/(app)/assistant';
import QrPayRoute from '../../../../app/(app)/qr';
import KycRoute from '../../../../app/(app)/kyc/index';
import KycLayout from '../../../../app/(app)/kyc/_layout';
import SendRoute from '../../../../app/(app)/send/index';
import SendLayout from '../../../../app/(app)/send/_layout';
import AuthLayout from '../../../../app/(auth)/_layout';
import LoginRoute from '../../../../app/(auth)/login';
import SignUpRoute from '../../../../app/(auth)/sign-up';
import WelcomeRoute from '../../../../app/(auth)/welcome';
import ChooseNemtagRoute from '../../../../app/choose-nemtag';
import Index from '../../../../app/index';
import { ToastProvider } from '@/components';
import { repositoriesFromDispatcher, RepositoryProvider, type Call } from '@/data';
import { RootNavigator } from '@/features/shell/RootNavigator';
import { haptic } from '@/lib/haptics';
import { QueryProvider } from '@/lib/query';
import { useDeepLinkStore, useSessionStore } from '@/stores';
import { ThemeProvider } from '@/theme';

// Loaded after the routes on purpose: importing it swaps in Reanimated's bundled
// mock, which lacks useReducedMotion. Modules loaded before keep the real one.
type RouterTesting = typeof import('expo-router/testing-library');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
const { renderRouter } = require('expo-router/testing-library') as RouterTesting;

jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const DAY_MS = 24 * 3_600_000;
const demoSession = (): AuthSession => ({
  access_token: 'access-1',
  access_token_expires_at: new Date(Date.now() + 600_000).toISOString(),
  refresh_token: 'refresh-1',
  refresh_token_expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
  token_type: 'Bearer',
  user: { id: 'user-1', is_demo: true } as AuthSession['user'],
  device: { id: 'device-1' } as AuthSession['device'],
});

const publicLink = {
  slug: 'k3x9q2ab',
  title: 'Ankara fabric',
  note: null,
  payee_name: 'Amaka Obi',
  amount_mode: 'open',
  amount: null,
  currency: 'NGN',
  status: 'active',
  demo: true,
};

let calls: Call[] = [];
const repositories = repositoriesFromDispatcher(async (call) => {
  calls.push(call);
  if (call.operationId === 'getPublicPaymentLink') return publicLink;
  return call.operationId === 'startDemoSession' ? demoSession() : undefined;
});

function RootLayout() {
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <RepositoryProvider repositories={repositories}>
        <QueryProvider client={new QueryClient()}>
          <ThemeProvider>
            <ToastProvider>
              <RootNavigator />
            </ToastProvider>
          </ThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </SafeAreaProvider>
  );
}

// The real layouts and routes from app/, under a root without fonts or data.
const ROUTES = {
  _layout: RootLayout,
  index: Index,
  '(auth)/_layout': AuthLayout,
  '(auth)/welcome': WelcomeRoute,
  '(auth)/login': LoginRoute,
  '(auth)/sign-up': SignUpRoute,
  // As a module, so the router sees its unstable_settings.
  '(app)/_layout': { default: AppLayout, unstable_settings: appSettings },
  '(app)/(tabs)/_layout': TabsLayout,
  '(app)/(tabs)/home': HomeRoute,
  '(app)/(tabs)/pay': PayRoute,
  '(app)/(tabs)/cards': CardsRoute,
  '(app)/(tabs)/grow': GrowRoute,
  '(app)/(tabs)/me': MeRoute,
  '(app)/send/_layout': SendLayout,
  '(app)/send/index': SendRoute,
  '(app)/convert/_layout': ConvertLayout,
  '(app)/convert/index': ConvertRoute,
  '(app)/kyc/_layout': KycLayout,
  '(app)/kyc/index': KycRoute,
  '(app)/demo-controls': DemoControlsRoute,
  'pay/[slug]': PaymentLinkRoute,
  '(app)/ajo/[code]': AjoInviteRoute,
  '(app)/qr': QrPayRoute,
  '(app)/assistant': AssistantRoute,
  'choose-nemtag': ChooseNemtagRoute,
  kit: () => null,
};

/**
 * RNTL 14 renders asynchronously; expo-router's helper hangs its route getters
 * on the returned promise, so keep a handle before awaiting it.
 */
async function open(initialUrl: string) {
  const rendered = await renderRouter(ROUTES, { initialUrl });
  return { pathname: () => rendered.getPathname() };
}

const signIn = () => useSessionStore.getState().setSession(demoSession());

beforeEach(() => {
  calls = [];
  useSessionStore.setState({ status: 'signedOut', session: null });
  useDeepLinkStore.setState({ pending: null });
});

describe('auth gate', () => {
  it('opens on welcome when nobody is signed in', async () => {
    const router = await open('/');
    expect(router.pathname()).toBe('/welcome');
  });

  it('restores a stored session straight to Home', async () => {
    signIn();
    const router = await open('/');
    expect(router.pathname()).toBe('/home');
  });

  it('keeps signed-out users out of the app', async () => {
    const router = await open('/cards');
    expect(router.pathname()).toBe('/welcome');
  });

  it('keeps signed-in users out of the auth screens', async () => {
    signIn();
    const router = await open('/login');
    expect(router.pathname()).toBe('/home');
  });

  it('sends a new account without an @nemtag to the chooser, and nowhere else', async () => {
    useSessionStore.getState().setSession({
      ...demoSession(),
      user: { id: 'user-1', is_demo: false, nemtag: null } as AuthSession['user'],
    });
    const router = await open('/cards');
    expect(router.pathname()).toBe('/choose-nemtag');
    await act(async () => useSessionStore.getState().nemtagChosen());
    expect(await screen.findByText('Recent activity')).toBeOnTheScreen();
    expect(router.pathname()).toBe('/home');
  });

  it('signs in with the demo and out again from Me', async () => {
    const router = await open('/welcome');
    await fireEvent.press(screen.getByRole('button', { name: 'Try the demo' }));
    expect(await screen.findByText('Recent activity')).toBeOnTheScreen();
    expect(router.pathname()).toBe('/home');
    // Home then loads its own data; the sign-in itself is one call.
    expect(calls.filter((c) => c.domain === 'auth').map((c) => c.operationId)).toEqual([
      'startDemoSession',
    ]);

    await fireEvent.press(screen.getByRole('tab', { name: 'Me' }));
    await fireEvent.press(await screen.findByText('Sign out'));
    await act(async () => undefined);
    expect(router.pathname()).toBe('/welcome');
    expect(useSessionStore.getState().session).toBeNull();
    expect(calls.filter((c) => c.domain === 'auth').map((c) => c.operationId)).toEqual([
      'startDemoSession',
      'logout',
    ]);
  });
});

describe('navigation structure', () => {
  beforeEach(signIn);

  it('opens on Home with the five tabs', async () => {
    const router = await open('/');
    expect(router.pathname()).toBe('/home');
    for (const tab of ['Home', 'Pay', 'Cards', 'Grow', 'Me']) {
      expect(screen.getByRole('tab', { name: tab })).toBeOnTheScreen();
    }
  });

  it('marks only the active tab as selected and says where each sits', async () => {
    await open('/cards');
    expect(screen.getByRole('tab', { name: 'Cards' })).toBeSelected();
    expect(screen.getByRole('tab', { name: 'Home' })).not.toBeSelected();
    expect(screen.getByRole('tab', { name: 'Me' }).props.accessibilityHint).toBe('5 of 5');
  });

  it('taps a selection haptic only when the tab changes', async () => {
    await open('/home');
    jest.mocked(haptic).mockClear();
    await fireEvent.press(screen.getByRole('tab', { name: 'Home' }));
    expect(haptic).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('tab', { name: 'Pay' }));
    expect(haptic).toHaveBeenCalledTimes(1);
    expect(haptic).toHaveBeenCalledWith('selection');
  });

  it('switches tabs', async () => {
    const router = await open('/home');
    await fireEvent.press(screen.getByRole('tab', { name: 'Grow' }));
    expect(router.pathname()).toBe('/grow');
    expect(await screen.findByText('Ways to save')).toBeOnTheScreen();
  });

  it('presents the send flow as a modal and closes it', async () => {
    const router = await open('/home');
    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    expect(router.pathname()).toBe('/send');
    await fireEvent.press(await screen.findByRole('button', { name: 'Close' }));
    expect(router.pathname()).toBe('/home');
  });

  it('reaches KYC and Demo Controls from Me', async () => {
    const router = await open('/me');
    await fireEvent.press(screen.getByText('Demo Controls'));
    expect(router.pathname()).toBe('/demo-controls');
    await fireEvent.press(await screen.findByRole('button', { name: 'Close' }));

    await fireEvent.press(await screen.findByText('Verify your identity'));
    expect(router.pathname()).toBe('/kyc');
  });

  it('walks the signed-out stack: welcome, log in, back', async () => {
    useSessionStore.setState({ status: 'signedOut', session: null });
    const router = await open('/welcome');
    await fireEvent.press(screen.getByRole('button', { name: 'Log in' }));
    expect(router.pathname()).toBe('/login');
    await fireEvent.press(await screen.findByRole('button', { name: 'Back' }));
    expect(router.pathname()).toBe('/welcome');
  });
});

describe('deep links', () => {
  it('opens a pay link as a modal, and closes to Home', async () => {
    signIn();
    const router = await open(await redirectPath('nembank://pay/k3x9q2ab'));
    expect(router.pathname()).toBe('/pay/k3x9q2ab');
    expect(await screen.findByText('Ankara fabric')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    expect(router.pathname()).toBe('/home');
  });

  it('shows a pay link to someone signed out, who logs in to pay', async () => {
    const router = await open(await redirectPath('https://nem-bank-fodx.vercel.app/pay/k3x9q2ab'));
    expect(router.pathname()).toBe('/pay/k3x9q2ab');
    expect(await screen.findByText('Ankara fabric')).toBeOnTheScreen();
    expect(screen.getByText(/Amaka Obi is asking you/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Log in to pay' }));
    expect(router.pathname()).toBe('/login');
  });

  it('parks a link opened while signed out and opens it after sign-in', async () => {
    const router = await open(await redirectPath('https://nem-bank-fodx.vercel.app/ajo/AB12CD'));
    expect(router.pathname()).toBe('/welcome');
    await fireEvent.press(screen.getByRole('button', { name: 'Try the demo' }));
    expect(await screen.findByText(/Invite AB12CD/)).toBeOnTheScreen();
    expect(router.pathname()).toBe('/ajo/AB12CD');
    expect(useDeepLinkStore.getState().pending).toBeNull();
  });

  it('drops a parked link on sign-out', () => {
    signIn();
    useDeepLinkStore.getState().setPending('/cards');
    useSessionStore.getState().signOut();
    expect(useDeepLinkStore.getState().pending).toBeNull();
  });

  it('never throws on a malformed link', async () => {
    signIn();
    await expect(redirectPath('%%%')).resolves.toBe('/home');
  });
});

async function redirectPath(path: string): Promise<string> {
  return (await redirectSystemPath({ path, initial: true })) ?? '/';
}
