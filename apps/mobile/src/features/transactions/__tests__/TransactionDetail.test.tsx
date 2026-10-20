import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { totalFees, TransactionDetailScreen } from '../TransactionDetailScreen';

let mockId = '';
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => ({ id: mockId }),
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));

configure({ defaultIncludeHiddenElements: true });

async function renderDetail(repos: Repositories) {
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <RepositoryProvider repositories={repos}>
        <QueryProvider
          client={
            new QueryClient({
              defaultOptions: {
                queries: { gcTime: Infinity, retry: false },
                mutations: { gcTime: Infinity },
              },
            })
          }
        >
          <ThemeProvider initialPreference="dark">
            <ToastProvider>
              <TransactionDetailScreen />
            </ToastProvider>
          </ThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </SafeAreaProvider>,
  );
}

it('adds up fee lines in minor units', () => {
  expect(
    totalFees({
      amount: { amount_minor: '100000', currency: 'NGN' },
      fees: [
        {
          code: 'transfer_fee',
          label: 'Transfer fee',
          amount: { amount_minor: '2500', currency: 'NGN' },
        },
        { code: 'emtl', label: 'EMTL', amount: { amount_minor: '5000', currency: 'NGN' } },
      ],
    }),
  ).toEqual({ amount: 7500n, currency: 'NGN' });
});

it('shows a sent transfer in full, recategorises it and offers repeat and dispute', async () => {
  const repos = createMockRepositories({
    store: createMemoryStore(),
    simulation: { latency: 'off' },
  });
  const sent = await repos.transactions.list({
    query: { type: ['transfer_out'], status: 'completed', limit: 50 },
  });
  const detail = await Promise.all(
    sent.data.map((t) => repos.transactions.get({ path: { transaction_id: t.id } })),
  );
  const t = detail.find((d) => d.can_repeat && d.can_dispute)!;
  expect(t).toBeDefined();
  mockId = t.id;
  await renderDetail(repos);

  expect(await screen.findByText(t.reference)).toBeTruthy();
  expect(screen.getByText('Status', { exact: true })).toBeTruthy();
  expect(screen.getAllByText(t.timeline.at(-1)!.label).length).toBeGreaterThan(0);

  await fireEvent.press(screen.getByRole('button', { name: /^Category/ }));
  await fireEvent.press(await screen.findByRole('checkbox', { name: /Also for every payment/ }));
  const target = t.category === 'shopping' ? 'Groceries' : 'Shopping';
  await fireEvent.press(screen.getByRole('button', { name: target }));
  expect(await screen.findByText(new RegExp(`${target} · set by you`))).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Send again' }));
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/send', params: { repeat: t.transfer_id } });
  await fireEvent.press(screen.getByRole('button', { name: 'Report a problem' }));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/disputes/new',
    params: { transaction: t.id },
  });
}, 20_000);
