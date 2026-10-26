import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { BillersScreen } from '../screens/BillersScreen';
import { BillsHubScreen } from '../screens/BillsHubScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
}));

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

describe('bills hub', () => {
  it('opens each kind of bill', async () => {
    await render(wrap(bank(), <BillsHubScreen />));
    for (const [label, path] of [
      ['Airtime', '/bills/airtime'],
      ['Data', '/bills/data'],
      ['Electricity', '/bills/electricity'],
      ['Cable TV', '/bills/cable_tv'],
    ]) {
      await fireEvent.press(screen.getByRole('button', { name: new RegExp(`^${label}\.`) }));
      expect(mockPush).toHaveBeenLastCalledWith(path);
    }
  });

  it('lists recent bills and saved billers', async () => {
    const repos = bank();
    const [ngn] = (await repos.accounts.list()).data;
    await repos.bills.pay({
      idempotencyKey: 'k1',
      body: {
        biller_id: 'mtn-airtime',
        customer_id: '08031234567',
        amount: { amount_minor: '50000', currency: 'NGN' },
        source_account_id: ngn!.id,
        save_as: 'My MTN',
      },
    });
    await render(wrap(repos, <BillsHubScreen />));
    expect(await screen.findByText('MTN Airtime')).toBeTruthy();
    expect(screen.getByText('₦500.00')).toBeTruthy();
    expect(await screen.findByText('My MTN')).toBeTruthy();
  });

  it('says so when there are no bills yet', async () => {
    await render(wrap(bank(), <BillsHubScreen />));
    expect(await screen.findByText('No bills yet')).toBeTruthy();
  });

  it('lists the providers for a kind of bill', async () => {
    await render(wrap(bank(), <BillersScreen category="electricity" />));
    expect(await screen.findByText('Ikeja Electric (prepaid)')).toBeTruthy();
    expect(screen.getAllByText('From ₦1,000')).toHaveLength(3);
  });
});
