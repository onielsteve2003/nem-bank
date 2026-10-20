import type { Schema } from '@nem/contracts';
import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components';
import { RepositoryProvider } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { activeFilterCount, formatDay, groupByDay, NO_FILTERS, toQuery } from '../filters';
import { TransactionsScreen } from '../TransactionsScreen';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

configure({ defaultIncludeHiddenElements: true });

const NOW = new Date('2026-10-20T10:00:00Z');
const txn = (id: string, created_at: string) => ({ id, created_at }) as Schema<'Transaction'>;

describe('transaction filters', () => {
  it('maps groups, currency, status and Lagos date ranges to the query', () => {
    expect(toQuery(NO_FILTERS, NOW)).toEqual({ limit: 30 });
    expect(
      toQuery(
        {
          types: ['card', 'bills'],
          currency: 'USD',
          status: 'pending',
          range: 'd7',
          search: ' Shoprite ',
        },
        NOW,
      ),
    ).toEqual({
      limit: 30,
      type: ['card_payment', 'card_refund', 'bill_payment'],
      currency: 'USD',
      status: 'pending',
      from: '2026-10-14',
      to: '2026-10-20',
      q: 'Shoprite',
    });
    expect(toQuery({ ...NO_FILTERS, range: 'month' }, NOW)).toMatchObject({ from: '2026-10-01' });
    // 23:30 UTC on the 31st is already 1 Nov in Lagos.
    expect(
      toQuery({ ...NO_FILTERS, range: 'month' }, new Date('2026-10-31T23:30:00Z')),
    ).toMatchObject({
      from: '2026-11-01',
    });
  });

  it('counts filters but not search', () => {
    expect(activeFilterCount({ ...NO_FILTERS, search: 'x' })).toBe(0);
    expect(activeFilterCount({ ...NO_FILTERS, types: ['card', 'fx'], range: 'd30' })).toBe(2);
  });

  it('puts a header before each Lagos day', () => {
    const rows = groupByDay(
      [
        txn('a', '2026-10-20T08:00:00Z'),
        txn('b', '2026-10-19T23:30:00Z'), // 00:30 on the 20th in Lagos
        txn('c', '2026-10-19T12:00:00Z'),
        txn('d', '2025-12-01T12:00:00Z'),
      ],
      NOW,
    );
    expect(rows.map((r) => (r.kind === 'day' ? r.label : r.key))).toEqual([
      'Today',
      'a',
      'b',
      'Yesterday',
      'c',
      'Mon, 1 Dec 2025',
      'd',
    ]);
    expect(formatDay('2026-10-12', NOW)).toBe('Mon, 12 Oct');
  });
});

it('lists, searches and filters the demo history', async () => {
  await render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <RepositoryProvider
        repositories={createMockRepositories({
          store: createMemoryStore(),
          simulation: { latency: 'off' },
        })}
      >
        <QueryProvider
          client={
            new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
          }
        >
          <ThemeProvider initialPreference="dark">
            <ToastProvider>
              <TransactionsScreen />
            </ToastProvider>
          </ThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </SafeAreaProvider>,
  );
  expect(await screen.findByTestId('transactions-list')).toBeTruthy();

  await fireEvent.changeText(screen.getByLabelText('Search transactions'), 'zzzz-no-such-thing');
  expect(await screen.findByText('No matching transactions', {}, { timeout: 3000 })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Clear filters' }));
  expect(await screen.findByTestId('transactions-list')).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Filters' }));
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Failed' }));
  await fireEvent.press(screen.getByRole('button', { name: 'Show results' }));
  expect(await screen.findByRole('button', { name: 'Remove Failed' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Filters, 1 on' })).toBeTruthy();
}, 20_000);
