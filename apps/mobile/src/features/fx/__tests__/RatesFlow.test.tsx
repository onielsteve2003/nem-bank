import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { nairaRate } from '../rates';
import { RatesScreen } from '../screens/RatesScreen';

const mockDismissTo = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), dismissTo: mockDismissTo }),
  useLocalSearchParams: () => ({}),
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

configure({ defaultIncludeHiddenElements: true });

const NOW = new Date('2026-10-21T10:00:00Z');
const bank = () =>
  createMockRepositories({
    store: createMemoryStore(),
    clock: () => NOW,
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

async function usdMid(repos: Repositories) {
  const { data } = await repos.fx.listRates();
  return data.find((r) => r.pair === 'USD-NGN')!.mid_rate;
}

describe('rates', () => {
  it('shows today’s rate and how it moved, for each range and pair', async () => {
    const repos = bank();
    const mid = await usdMid(repos);
    await render(wrap(repos, <RatesScreen />));
    expect(await screen.findByLabelText(`USD/NGN is ${nairaRate('USD-NGN', mid)}`)).toBeTruthy();
    expect(await screen.findByLabelText(/^(up|down|flat) [+-]?\d+\.\d{2}% over the last week$/));

    await fireEvent.press(screen.getByRole('togglebutton', { name: '1Y' }));
    expect(await screen.findByLabelText(/over the last year$/)).toBeTruthy();

    await fireEvent.press(screen.getByRole('togglebutton', { name: 'GBP/NGN' }));
    expect(await screen.findByLabelText(/^GBP\/NGN is ₦/)).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Convert GBP' }));
    expect(mockDismissTo).toHaveBeenCalledWith('/convert');
  });
});

describe('rate alerts', () => {
  it('lists alerts, creates one (refusing one that would fire at once) and deletes it', async () => {
    const repos = bank();
    const mid = Number(await usdMid(repos));
    await render(wrap(repos, <RatesScreen />));
    // The demo persona already watches USD/NGN above ₦1,650.
    expect(await screen.findByText('USD/NGN above ₦1,650.00')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'New alert for USD/NGN' }));
    await screen.findByText(/now\. We notify you once/);

    const field = screen.getByLabelText(/^Rate in naira/);
    await fireEvent.changeText(field, String(Math.floor(mid - 50)));
    await fireEvent(field, 'blur');
    expect(await screen.findByText(/is already at ₦.*Pick a higher rate\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create alert' })).toBeDisabled();

    const target = String(Math.ceil(mid + 30));
    await fireEvent.changeText(field, target);
    await fireEvent.press(screen.getByRole('button', { name: 'Create alert' }));

    const title = `USD/NGN above ${nairaRate('USD-NGN', target)}`;
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.getAllByLabelText('Watching')).toHaveLength(2);
    expect((await repos.fx.listAlerts()).data).toHaveLength(2);

    await fireEvent.press(screen.getByRole('button', { name: `Delete alert: ${title}` }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByText(title)).toBeNull());
    expect((await repos.fx.listAlerts()).data).toHaveLength(1);
  });
});
