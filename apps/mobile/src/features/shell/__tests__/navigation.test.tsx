import { fireEvent, screen } from '@testing-library/react-native';
import { Slot } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import AppLayout from '../../../../app/(app)/_layout';
import CardsRoute from '../../../../app/(app)/(tabs)/cards';
import GrowRoute from '../../../../app/(app)/(tabs)/grow';
import HomeRoute from '../../../../app/(app)/(tabs)/home';
import MeRoute from '../../../../app/(app)/(tabs)/me';
import PayRoute from '../../../../app/(app)/(tabs)/pay';
import TabsLayout from '../../../../app/(app)/(tabs)/_layout';
import ConvertRoute from '../../../../app/(app)/convert/index';
import ConvertLayout from '../../../../app/(app)/convert/_layout';
import DemoControlsRoute from '../../../../app/(app)/demo-controls';
import KycRoute from '../../../../app/(app)/kyc/index';
import KycLayout from '../../../../app/(app)/kyc/_layout';
import SendRoute from '../../../../app/(app)/send/index';
import SendLayout from '../../../../app/(app)/send/_layout';
import AuthLayout from '../../../../app/(auth)/_layout';
import LoginRoute from '../../../../app/(auth)/login';
import SignUpRoute from '../../../../app/(auth)/sign-up';
import WelcomeRoute from '../../../../app/(auth)/welcome';
import Index from '../../../../app/index';
import { ThemeProvider } from '@/theme';

// Loaded after the routes on purpose: importing it swaps in Reanimated's bundled
// mock, which lacks useReducedMotion. Modules loaded before keep the real one.
type RouterTesting = typeof import('expo-router/testing-library');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
const { renderRouter } = require('expo-router/testing-library') as RouterTesting;

const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function RootLayout() {
  return (
    <SafeAreaProvider initialMetrics={metrics}>
      <ThemeProvider>
        <Slot />
      </ThemeProvider>
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
  '(app)/_layout': AppLayout,
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
};

/**
 * RNTL 14 renders asynchronously; expo-router's helper hangs its route getters
 * on the returned promise, so keep a handle before awaiting it.
 */
async function open(initialUrl: string) {
  const rendered = renderRouter(ROUTES, { initialUrl });
  await rendered;
  return { pathname: () => rendered.getPathname() };
}

describe('navigation structure', () => {
  it('opens on Home with the five tabs', async () => {
    const router = await open('/');
    expect(router.pathname()).toBe('/home');
    for (const tab of ['Home', 'Pay', 'Cards', 'Grow', 'Me']) {
      expect(screen.getAllByText(tab).length).toBeGreaterThan(0);
    }
  });

  it('switches tabs', async () => {
    const router = await open('/home');
    await fireEvent.press(screen.getByRole('button', { name: /^Grow, tab/ }));
    expect(router.pathname()).toBe('/grow');
    expect(await screen.findByText('Grow is on its way')).toBeOnTheScreen();
  });

  it('presents the send flow as a modal and closes it', async () => {
    const router = await open('/home');
    await fireEvent.press(screen.getByRole('button', { name: 'Send money' }));
    expect(router.pathname()).toBe('/send');
    await fireEvent.press(await screen.findByRole('button', { name: 'Close' }));
    expect(router.pathname()).toBe('/home');
  });

  it('reaches KYC, Demo Controls and the welcome screens from Me', async () => {
    const router = await open('/me');
    await fireEvent.press(screen.getByText('Demo Controls'));
    expect(router.pathname()).toBe('/demo-controls');
    await fireEvent.press(await screen.findByRole('button', { name: 'Close' }));

    await fireEvent.press(await screen.findByText('Verify your identity'));
    expect(router.pathname()).toBe('/kyc');
  });

  it('walks the signed-out stack: welcome, log in, back', async () => {
    const router = await open('/welcome');
    await fireEvent.press(screen.getByRole('button', { name: 'Log in' }));
    expect(router.pathname()).toBe('/login');
    await fireEvent.press(await screen.findByRole('button', { name: 'Back' }));
    expect(router.pathname()).toBe('/welcome');
  });
});
