import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { NewSplitScreen } from '../screens/NewSplitScreen';
import { SplitBillScreen } from '../screens/SplitBillScreen';

let mockParams: Record<string, string> = {};
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: mockReplace,
    back: jest.fn(),
    dismissTo: jest.fn(),
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

configure({ defaultIncludeHiddenElements: true });

const bank = () =>
  createMockRepositories({ store: createMemoryStore(), simulation: { latency: 'off' } });

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

const ngn = (major: number) => ({ amount_minor: String(major * 100), currency: 'NGN' as const });

beforeEach(() => {
  mockReplace.mockClear();
  mockParams = {};
});

async function addEmeka() {
  await fireEvent.changeText(screen.getByLabelText(/^Add a Nem user/), '@emeka');
  await fireEvent.press(await screen.findByRole('button', { name: 'Add Emeka Nwosu' }));
}

it('splits a bill equally, the leftover kobo staying with the creator', async () => {
  const repos = bank();
  await render(wrap(repos, <NewSplitScreen />));
  await fireEvent.changeText(screen.getByLabelText(/^What's it for/), 'Dinner');
  await fireEvent.changeText(screen.getByLabelText(/^Total/), '10,000.01');
  await addEmeka();
  await fireEvent.changeText(screen.getByLabelText(/^Add a Nem user/), 'kunle');
  await fireEvent.press(await screen.findByRole('button', { name: 'Add Kunle Adeyemi' }));

  // ₦10,000.01 three ways: ₦3,333.33 each for two friends, ₦3,333.35 for the creator.
  expect(screen.getAllByText('₦3,333.33')).toHaveLength(2);
  expect(screen.getByText('₦3,333.35')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Send 2 requests' }));

  await waitFor(() => expect(mockReplace).toHaveBeenCalled());
  const { data } = await repos.moneyRequests.listSplitBills();
  expect(data).toHaveLength(1);
  const amounts = data[0]!.shares.map((s) => s.amount.amount_minor);
  expect(amounts).toEqual(['333335', '333333', '333333']);
  expect(mockReplace).toHaveBeenCalledWith({
    pathname: '/send/splits/[id]',
    params: { id: data[0]!.id },
  });
});

it('checks custom shares against the total', async () => {
  const repos = bank();
  await render(wrap(repos, <NewSplitScreen />));
  await fireEvent.changeText(screen.getByLabelText(/^What's it for/), 'Fuel');
  await fireEvent.changeText(screen.getByLabelText(/^Total/), '5000');
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Custom amounts' }));
  await addEmeka();

  await fireEvent.changeText(screen.getByLabelText(/^Emeka's share/), '6000');
  expect(await screen.findByText('The shares come to more than the total')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Send 1 request' })).toBeDisabled();

  await fireEvent.changeText(screen.getByLabelText(/^Emeka's share/), '2000');
  expect(screen.getByText('₦3,000.00')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Send 1 request' }));
  await waitFor(() => expect(mockReplace).toHaveBeenCalled());
  const [split] = (await repos.moneyRequests.listSplitBills()).data;
  expect(split!.shares.map((s) => s.amount.amount_minor)).toEqual(['300000', '200000']);
});

it('shows who has paid and reminds the rest once a day', async () => {
  const repos = bank();
  const split = await repos.moneyRequests.createSplitBill({
    body: {
      title: 'Trip to Epe',
      total: ngn(9_000),
      split: 'equal',
      include_self: true,
      participants: [{ nemtag: 'emeka' }, { nemtag: 'kunle' }],
    },
  });
  mockParams = { id: split.id };
  await render(wrap(repos, <SplitBillScreen />));
  expect(await screen.findByText('Trip to Epe')).toBeTruthy();
  expect(screen.getByText('0 of 2 paid')).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: "Remind those who haven't paid" }));
  expect(await screen.findByText('Reminder sent to 2 people.')).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: "Remind those who haven't paid" })).toBeDisabled(),
  );
  expect(screen.getAllByText('Reminded just now')).toHaveLength(2);
  await expect(
    repos.moneyRequests.remindSplitBill({ path: { split_bill_id: split.id } }),
  ).rejects.toMatchObject({ code: 'rate_limited' });
});
