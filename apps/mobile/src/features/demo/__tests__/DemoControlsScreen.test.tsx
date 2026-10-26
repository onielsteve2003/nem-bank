import type { AuthSession } from '@nem/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockBank, type Simulation } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { createQueryClient, QueryProvider } from '@/lib/query';
import { useDemoStore, useSessionStore } from '@/stores';
import { ThemeProvider } from '@/theme';

import { DemoControlsScreen } from '../screens/DemoControlsScreen';

jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ back: jest.fn() }),
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const session = (isDemo: boolean): AuthSession => ({
  access_token: 'a',
  access_token_expires_at: new Date(Date.now() + 600_000).toISOString(),
  refresh_token: 'r',
  refresh_token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  token_type: 'Bearer',
  user: { id: 'u', is_demo: isDemo } as AuthSession['user'],
  device: { id: 'd' } as AuthSession['device'],
});

// Query clients keep 24 h garbage-collection timers; clear them so Jest can exit.
const clients: QueryClient[] = [];
afterEach(() => clients.splice(0).forEach((client) => client.clear()));

async function mount(repositories: Repositories, simulation: Simulation | null = null) {
  const client = createQueryClient();
  clients.push(client);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <RepositoryProvider repositories={repositories} simulation={simulation}>
        <QueryProvider client={client}>
          <ThemeProvider initialPreference="dark">
            <ToastProvider>
              <DemoControlsScreen />
            </ToastProvider>
          </ThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </SafeAreaProvider>,
  );
}

async function renderScreen() {
  const bank = createMockBank({
    store: createMemoryStore(),
    clock: () => new Date('2026-10-17T12:00:00Z'),
    simulation: { latency: 'off' },
    pulseMs: 60_000,
  });
  await mount(bank.repositories, bank.simulation);
  await screen.findByText('NGN wallet');
  return bank;
}

const ngnBalance = () =>
  screen.getByLabelText(/^NGN wallet balance/).props.accessibilityLabel as string;

beforeEach(() => {
  useSessionStore.getState().setSession(session(true));
  useDemoStore.getState().resetSimulation();
});

it('adds demo money to the chosen wallet through the ledger', async () => {
  await renderScreen();
  const before = ngnBalance();
  await fireEvent.press(screen.getByRole('button', { name: 'Add demo money' }));
  expect(await screen.findByText('₦50,000.00 added to your NGN wallet')).toBeOnTheScreen();
  await waitFor(() => expect(ngnBalance()).not.toBe(before));
});

it('simulates an incoming transfer from another bank', async () => {
  await renderScreen();
  await fireEvent.press(screen.getByRole('togglebutton', { name: '₦5,000' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Receive from Chidinma Okafor' }));
  expect(await screen.findByText('Chidinma Okafor sent you ₦5,000.00')).toBeOnTheScreen();
});

it('arms a failed bank transfer and travels forward in time', async () => {
  await renderScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Fail my next bank transfer' }));
  expect(await screen.findByText(/next bank transfer will fail/)).toBeOnTheScreen();

  await fireEvent.press(screen.getByRole('togglebutton', { name: '30 days' }));
  expect(await screen.findByText(/goals would earn about ₦[\d,.]+ in interest/)).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Jump 30 days ahead' }));
  expect(await screen.findByText(/^Demo date .*, 30 days ahead$/)).toBeOnTheScreen();
  // Goal interest is paid daily and the seeded ajo pays out its next four turns.
  expect(
    await screen.findByText(/^₦[\d,.]+ interest earned · 4 ajo payouts made$/),
  ).toBeOnTheScreen();
});

it('switches the mock bank offline and back to defaults', async () => {
  await renderScreen();
  await fireEvent.press(screen.getByRole('switch', { name: /Bank offline/ }));
  expect(useDemoStore.getState().simulation.offline).toBe(true);
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Slow 3G' }));
  expect(useDemoStore.getState().simulation.latency).toBe('slow');
  await fireEvent.press(screen.getByRole('button', { name: 'Reset network' }));
  expect(useDemoStore.getState().simulation).toMatchObject({
    offline: false,
    latency: 'realistic',
  });
});

it('resets the demo only after confirming', async () => {
  await renderScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Reset demo data' }));
  expect(screen.getByText('Reset the demo?')).toBeOnTheScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'Reset' }));
  expect(await screen.findByText('Demo data reset')).toBeOnTheScreen();
});

it('ends the session as if it had expired', async () => {
  await renderScreen();
  await fireEvent.press(screen.getByRole('button', { name: 'End my session' }));
  expect(useSessionStore.getState()).toMatchObject({ status: 'signedOut', endedBy: 'expired' });
});

it('is closed to accounts that are not the demo', async () => {
  useSessionStore.getState().setSession(session(false));
  await mount(createMockBank({ store: createMemoryStore() }).repositories);
  expect(screen.getByText('Only for the demo account')).toBeOnTheScreen();
});
