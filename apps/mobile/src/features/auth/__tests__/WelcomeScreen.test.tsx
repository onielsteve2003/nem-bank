import { QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { repositoriesFromDispatcher, RepositoryProvider, type Dispatcher } from '@/data';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { WelcomeScreen } from '../screens/WelcomeScreen';
import { WELCOME_SLIDES } from '../welcomeSlides';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

// Cache gc timers would keep Jest alive after the suite.
const NO_GC_TIMERS = {
  defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
};

const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

async function renderWelcome(dispatch: Dispatcher = async () => undefined) {
  await render(
    <SafeAreaProvider initialMetrics={metrics}>
      <RepositoryProvider repositories={repositoriesFromDispatcher(dispatch)}>
        <QueryProvider client={new QueryClient(NO_GC_TIMERS)}>
          <ThemeProvider initialPreference="dark">
            <WelcomeScreen />
          </ThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </SafeAreaProvider>,
  );
}

describe('WelcomeScreen', () => {
  beforeEach(() => mockPush.mockClear());

  it('says plainly that this is a demo, not a bank', async () => {
    await renderWelcome();
    expect(screen.getByText(/Not a real bank/)).toBeOnTheScreen();
    expect(screen.getByText(/no real money\s+moves/)).toBeOnTheScreen();
  });

  it('pages through the slides by dot and by screen-reader swipe', async () => {
    await renderWelcome();
    const carousel = screen.getByRole('adjustable');
    expect(carousel).toHaveAccessibilityValue({ text: `Slide 1 of ${WELCOME_SLIDES.length}` });

    await fireEvent.press(screen.getByRole('button', { name: 'Slide 3 of 4' }));
    expect(carousel).toHaveAccessibilityValue({ text: 'Slide 3 of 4' });

    await fireEvent(carousel, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    await fireEvent(carousel, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(carousel).toHaveAccessibilityValue({ text: 'Slide 4 of 4' });

    await fireEvent(carousel, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } });
    expect(carousel).toHaveAccessibilityValue({ text: 'Slide 3 of 4' });
  });

  it('starts the seeded demo session in one tap', async () => {
    const dispatch = jest.fn<ReturnType<Dispatcher>, Parameters<Dispatcher>>(async () => undefined);
    await renderWelcome(dispatch);
    await fireEvent.press(screen.getByRole('button', { name: 'Try the demo' }));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'startDemoSession', input: { body: { persona: 'tolu' } } }),
    );
  });

  it('opens sign-up and log-in', async () => {
    await renderWelcome();
    await fireEvent.press(screen.getByRole('button', { name: 'Create account' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Log in' }));
    expect(mockPush.mock.calls).toEqual([['/sign-up'], ['/login']]);
  });
});
