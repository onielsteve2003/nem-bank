import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { conversionTitle } from '../history';
import { ConversionHistoryScreen } from '../screens/ConversionHistoryScreen';

const mockPush = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack }),
}));
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

/** Converts through the mock bank as the Convert screen would: quote, then convert. */
async function convert(repos: Repositories, from: string, to: string, major: bigint, key: string) {
  const { data } = await repos.accounts.list();
  const wallet = (c: string) => data.find((a) => a.currency === c)!;
  const minor = major * 100n;
  const quote = await repos.fx.createQuote({
    body: {
      from_account_id: wallet(from).id,
      to_account_id: wallet(to).id,
      sell_amount: { amount_minor: minor.toString(), currency: from as 'NGN' },
    },
  });
  return repos.fx.convert({ body: { quote_id: quote.quote_id }, idempotencyKey: key });
}

beforeEach(() => {
  mockPush.mockClear();
  mockBack.mockClear();
});

describe('conversion history', () => {
  it('names a conversion by its two currencies', () => {
    expect(
      conversionTitle({
        sell: { amount_minor: '100', currency: 'USD' },
        buy: { amount_minor: '150000', currency: 'NGN' },
      } as Parameters<typeof conversionTitle>[0]),
    ).toBe('USD to NGN');
  });

  it('lists conversions newest first and opens one in full', async () => {
    const repos = bank();
    await convert(repos, 'NGN', 'USD', 16_000n, 'fx-1');
    const latest = await convert(repos, 'USD', 'NGN', 5n, 'fx-2');
    await render(wrap(repos, <ConversionHistoryScreen />));

    const titles = await screen.findAllByText(/^(NGN to USD|USD to NGN)$/);
    expect(titles.map((t) => t.props.children)).toEqual(['USD to NGN', 'NGN to USD']);

    await fireEvent.press(titles[0]!);
    expect(await screen.findByText('Rate')).toBeTruthy();
    expect(screen.getByText(/^\$1 = ₦1,/)).toBeTruthy();
    expect(screen.getByText('Free')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'NGN wallet entry' }));
    expect(mockPush).toHaveBeenCalledWith(`/transactions/${latest.credit_transaction_id}`);
  });

  it('says so when there are none, and points back to Convert', async () => {
    await render(wrap(bank(), <ConversionHistoryScreen />));
    expect(await screen.findByText('No conversions yet')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Convert now' }));
    expect(mockBack).toHaveBeenCalled();
  });

  it('offers a retry when the history fails to load', async () => {
    const base = bank();
    const repos = {
      ...base,
      fx: {
        ...base.fx,
        listConversions: async () => {
          throw new Error('boom');
        },
      },
    };
    await render(wrap(repos, <ConversionHistoryScreen />));
    expect(await screen.findByText("We couldn't load your conversions")).toBeTruthy();
  });
});
