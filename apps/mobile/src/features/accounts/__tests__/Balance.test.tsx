import type { Schema } from '@nem/contracts';
import { money } from '@nem/shared';
import { QueryClient } from '@tanstack/react-query';
import { configure, render, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { balanceBreakdown } from '../balance';
import { BalanceExplainerSheet } from '../BalanceExplainerSheet';
import { BalanceTick } from '../BalanceTick';

configure({ defaultIncludeHiddenElements: true });

const ngn = (minor: string) => ({ amount_minor: minor, currency: 'NGN' as const });
const account = {
  id: '00000000-0000-4000-8000-0000000000aa',
  currency: 'NGN',
  kind: 'ngn_current',
  status: 'active',
  nickname: null,
  ledger_balance: ngn('10000000'),
  available_balance: ngn('9200000'),
  receiving_details: {
    scheme: 'nuban',
    bank_name: 'Nem Bank (demo)',
    bank_code: '090999',
    account_number: '0123456789',
    account_name: 'Tolulope Adebayo',
    demo: true,
  },
  opened_at: '2026-04-01T00:00:00Z',
} as Schema<'Account'>;
const hold = (minor: string, reason: Schema<'HoldReason'>): Schema<'Hold'> => ({
  id: `h-${minor}`,
  account_id: account.id,
  amount: ngn(minor),
  reason,
  reference: `H${minor}`,
  created_at: '2026-10-20T08:00:00Z',
  expires_at: null,
});

it('splits ledger into holds and available, and surfaces holds the list misses', () => {
  const full = balanceBreakdown(account, [
    hold('500000', 'card_authorization'),
    hold('300000', 'pending_transfer'),
  ]);
  expect(full.onHold).toEqual(money(800_000n, 'NGN'));
  expect(full.unlisted).toEqual(money(0n, 'NGN'));
  const partial = balanceBreakdown(account, [hold('500000', 'card_authorization')]);
  expect(partial.unlisted).toEqual(money(300_000n, 'NGN'));
});

it('explains the balance with each hold', async () => {
  const base = createMockRepositories({
    store: createMemoryStore(),
    simulation: { latency: 'off' },
  });
  const repos: Repositories = {
    ...base,
    accounts: {
      ...base.accounts,
      listHolds: async () => ({
        data: [hold('500000', 'card_authorization'), hold('300000', 'pending_transfer')],
        total: ngn('800000'),
      }),
    },
  };
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
            new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } })
          }
        >
          <ThemeProvider initialPreference="dark">
            <BalanceExplainerSheet account={account} hidden={false} onClose={jest.fn()} />
          </ThemeProvider>
        </QueryProvider>
      </RepositoryProvider>
    </SafeAreaProvider>,
  );
  expect(await screen.findByText('Card payment waiting to settle')).toBeTruthy();
  expect(screen.getByText('Transfer on its way')).toBeTruthy();
  expect(screen.getByLabelText('₦100,000.00')).toBeTruthy();
  expect(screen.getByLabelText('₦92,000.00')).toBeTruthy();
});

describe('BalanceTick', () => {
  const renderTick = (minor: bigint, hidden = false) => (
    <ThemeProvider initialPreference="dark">
      <BalanceTick value={money(minor, 'NGN')} hidden={hidden} color="text" label="Naira" />
    </ThemeProvider>
  );

  // Real timers: RNTL 14's async render hangs under fake timers (see T4.4 notes).
  it('shows nothing on first render, then the change, announces it and fades', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const view = await render(renderTick(100_000n));
    expect(screen.queryByText(/₦/)).toBeNull();
    await view.rerender(renderTick(600_000n));
    expect(screen.getByText('+₦5,000.00')).toBeTruthy();
    expect(announce).toHaveBeenCalledWith('Naira balance went up by ₦5,000.00');
    await waitFor(() => expect(screen.queryByText('+₦5,000.00')).toBeNull(), { timeout: 4_000 });
  });

  it('shows only the direction in privacy mode', async () => {
    const view = await render(renderTick(600_000n, true));
    await view.rerender(renderTick(100_000n, true));
    expect(screen.getByText('▼ Money out')).toBeTruthy();
    expect(screen.queryByText(/₦/)).toBeNull();
  });
});
