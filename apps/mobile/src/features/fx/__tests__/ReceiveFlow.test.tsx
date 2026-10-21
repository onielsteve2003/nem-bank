import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { RECEIVE_GUIDES, receiveSteps } from '../receive';
import { ReceiveScreen } from '../screens/ReceiveScreen';

let mockParams: Record<string, string> = {};
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: mockReplace }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

configure({ defaultIncludeHiddenElements: true });

const bank = () =>
  createMockRepositories({
    store: createMemoryStore(),
    clock: () => new Date(Date.now()),
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

const balance = async (repos: Repositories, currency: string) => {
  const { data } = await repos.accounts.list();
  return BigInt(data.find((a) => a.currency === currency)!.available_balance.amount_minor);
};

beforeEach(() => {
  mockParams = {};
  mockReplace.mockClear();
});

describe('receive guide', () => {
  it('names the local rail in the steps', () => {
    const steps = receiveSteps('GBP', RECEIVE_GUIDES.uk_fps);
    expect(steps).toHaveLength(4);
    expect(steps[1]).toContain('Faster Payments');
    expect(steps[2]).toContain('GBP wallet as British Pound');
  });
});

describe('receive from abroad', () => {
  it('shows the USD details and how ACH reaches them', async () => {
    await render(wrap(bank(), <ReceiveScreen />));
    expect(await screen.findByLabelText(/^Routing number \(ACH\): \d{9}$/)).toBeTruthy();
    expect(screen.getByText('Demo details')).toBeTruthy();
    expect(screen.getByLabelText(/^Step 2: .*ACH or domestic wire in the US/)).toBeTruthy();
    expect(screen.getByLabelText(/^Fees: Free to receive/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy routing number (ach)' })).toBeTruthy();
  });

  it('a simulated payment lands in the wallet and the list', async () => {
    const repos = bank();
    const before = await balance(repos, 'USD');
    await render(wrap(repos, <ReceiveScreen />));
    const simulate = await screen.findByRole('button', { name: 'Get $500 from Upwork Global Inc' });
    await fireEvent.press(simulate);

    expect(await screen.findByText('Upwork Global Inc sent you $500.00')).toBeTruthy();
    expect(await balance(repos, 'USD')).toBe(before + 50_000n);
    await waitFor(() => expect(screen.queryByText(/^Nothing yet/)).toBeNull());
    expect(screen.getAllByText(/Upwork Global Inc|Freelance payout/).length).toBeGreaterThan(0);
  });

  it('offers to open a foreign wallet when there is none', async () => {
    const base = bank();
    const all = await base.accounts.list();
    const nairaOnly = { ...all, data: all.data.filter((a) => a.currency === 'NGN') };
    const repos = { ...base, accounts: { ...base.accounts, list: async () => nairaOnly } };
    await render(wrap(repos, <ReceiveScreen />));
    expect(await screen.findByText('Open a foreign wallet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a wallet' })).toBeTruthy();
  });

  it('from a wallet sheet, converts by replacing the screen with Convert', async () => {
    mockParams = { currency: 'USD', entry: 'wallet' };
    await render(wrap(bank(), <ReceiveScreen />));
    await fireEvent.press(await screen.findByRole('button', { name: 'Convert USD to naira' }));
    expect(mockReplace).toHaveBeenCalledWith({ pathname: '/convert', params: { from: 'USD' } });
  });
});
