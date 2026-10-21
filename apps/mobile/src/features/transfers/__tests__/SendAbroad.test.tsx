import { money } from '@nem/shared';
import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { abroadFee, DESTINATIONS, receiveEstimate, recipientProblems } from '../abroad';
import { SendAbroadScreen } from '../screens/SendAbroadScreen';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), canGoBack: () => true }),
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

configure({ defaultIncludeHiddenElements: true });

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

const [UK, US, IE] = DESTINATIONS;
const naira = (major: number) => money(BigInt(major) * 100n, 'NGN');

it('prices the transfer, takes the recipient, then shows the Paid Feature Notice', async () => {
  const repos = createMockRepositories({
    store: createMemoryStore(),
    simulation: { latency: 'off' },
  });
  const before = (await repos.accounts.list()).data.find((a) => a.currency === 'NGN')!
    .available_balance.amount_minor;
  await render(wrap(repos, <SendAbroadScreen />));

  for (const key of ['1', '0', '0', '0', '0', '0']) {
    await fireEvent.press(screen.getByRole('button', { name: key }));
  }
  // What arrives, as opposed to the "£1 = ₦…" rate line.
  expect(await screen.findByText(/^£[\d,]+\.\d\d$/)).toBeTruthy();
  expect(screen.getByText('₦2,000.00')).toBeTruthy();
  expect(screen.getByText('₦102,000.00')).toBeTruthy();

  const send = screen.getByRole('button', { name: 'Send ₦100,000.00' });
  expect(send).toBeDisabled();
  await fireEvent.changeText(screen.getByLabelText(/^Full name/), 'Chiamaka Okafor');
  await fireEvent.changeText(screen.getByLabelText(/^Account number or IBAN/), '12345678');
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'School fees' }));
  await waitFor(() => expect(send).toBeEnabled());
  await fireEvent.press(send);

  expect(await screen.findByText('This feature needs a paid partner service')).toBeTruthy();
  const after = (await repos.accounts.list()).data.find((a) => a.currency === 'NGN')!
    .available_balance.amount_minor;
  expect(after).toBe(before);
});

describe('send abroad rules', () => {
  it('charges 1%, at least ₦2,000 and at most ₦25,000', () => {
    expect(abroadFee(naira(50_000))).toEqual(naira(2_000));
    expect(abroadFee(naira(500_000))).toEqual(naira(5_000));
    expect(abroadFee(naira(10_000_000))).toEqual(naira(25_000));
  });

  it('estimates what arrives, rounding down', () => {
    // ₦2,000.50 per pound: ₦100,000 buys £49.98 (49.987…).
    expect(receiveEstimate(naira(100_000), '2000.5', 'GBP')).toEqual(money(4998n, 'GBP'));
  });

  it('checks account details the way the destination expects', () => {
    expect(
      recipientProblems({ name: 'Chiamaka Okafor', account: '1234 5678', bic: '' }, UK!),
    ).toEqual({});
    expect(recipientProblems({ name: 'Chiamaka', account: '', bic: '' }, UK!).name).toBeDefined();
    expect(recipientProblems({ name: '', account: '12-34', bic: '' }, US!).account).toBe(
      'A US account number has 4 to 17 digits',
    );
    expect(
      recipientProblems({ name: '', account: 'IE29 AIBK 9311 5212 3456 78', bic: '' }, IE!),
    ).toEqual({});
    expect(
      recipientProblems({ name: '', account: 'DE89370400440532013000', bic: '' }, IE!).account,
    ).toBe('An IBAN from Ireland starts with IE');
    expect(recipientProblems({ name: '', account: '', bic: 'CHAS US33' }, US!)).toEqual({});
    expect(recipientProblems({ name: '', account: '', bic: 'CHASE' }, US!).bic).toBeDefined();
  });
});
