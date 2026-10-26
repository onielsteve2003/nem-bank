import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories, DEMO_PIN } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { BillReceiptScreen, tokenMessage } from '../screens/BillReceiptScreen';
import { BillsHubScreen } from '../screens/BillsHubScreen';
import { TopUpScreen } from '../screens/TopUpScreen';
import { UtilityScreen } from '../screens/UtilityScreen';

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: jest.fn() }),
}));

jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));
jest.mock('expo-local-authentication', () => ({
  AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2 },
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  supportedAuthenticationTypesAsync: jest.fn(async () => []),
  authenticateAsync: jest.fn(async () => ({ success: false })),
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
});

describe('airtime and data', () => {
  const typePhone = async (number: string) => {
    const field = screen.getByLabelText('Phone number');
    await fireEvent.changeText(field, '');
    await fireEvent.changeText(field, number);
  };

  it('detects the network from the number and lists its bundles', async () => {
    await render(wrap(bank(), <TopUpScreen category="data" />));
    await typePhone('08021234567');
    await waitFor(() =>
      expect(screen.getByRole('togglebutton', { name: 'Airtel' })).toBeSelected(),
    );
    expect(await screen.findByText('10GB, 30 days')).toBeTruthy();
  });

  it('buys airtime with the PIN and opens the receipt', async () => {
    const repos = bank();
    await render(wrap(repos, <TopUpScreen category="airtime" />));
    await typePhone('08031234567');
    await fireEvent.press(screen.getByRole('togglebutton', { name: '₦500' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Buy ₦500/ })).not.toBeDisabled(),
    );
    await fireEvent.press(screen.getByRole('button', { name: /^Buy ₦500/ }));
    for (const digit of DEMO_PIN) {
      // The amount keypad has digits too; the PIN pad is the sheet on top.
      await fireEvent.press((await screen.findAllByRole('button', { name: digit })).at(-1)!);
    }
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    const [paid] = (await repos.bills.listPayments()).data;
    expect(paid).toMatchObject({ biller_id: 'mtn-airtime', customer_id: '08031234567' });
  });
});

describe('electricity and cable TV', () => {
  const pin = async () => {
    for (const digit of DEMO_PIN) {
      await fireEvent.press((await screen.findAllByRole('button', { name: digit })).at(-1)!);
    }
  };

  it('checks the meter, buys units and shows a shareable token', async () => {
    const repos = bank();
    await render(wrap(repos, <UtilityScreen category="electricity" />));
    await fireEvent.press(
      await screen.findByRole('togglebutton', { name: 'Ikeja Electric (prepaid)' }),
    );
    await fireEvent.changeText(screen.getByLabelText('Meter number'), '45031234567');
    expect(await screen.findByText('12 Admiralty Way, Lekki Phase 1')).toBeTruthy();
    for (const key of ['5', '0', '0', '0']) {
      await fireEvent.press(screen.getAllByRole('button', { name: key })[0]!);
    }
    await fireEvent.press(await screen.findByRole('button', { name: /^Pay ₦5,000/ }));
    await pin();
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());

    const [paid] = (await repos.bills.listPayments()).data;
    expect(paid!.token).toMatch(/^\d{4}(-\d{4}){4}$/);
    await render(wrap(repos, <BillReceiptScreen id={paid!.id} />));
    expect(await screen.findByText(paid!.token!)).toBeTruthy();
    expect(screen.getByText(/22.2 kWh/)).toBeTruthy();
    expect(tokenMessage(paid!)).toContain('meter 45031234567');
  });

  it('says when the smartcard is not found', async () => {
    await render(wrap(bank(), <UtilityScreen category="cable_tv" />));
    await fireEvent.press(await screen.findByRole('togglebutton', { name: 'DStv' }));
    await fireEvent.changeText(screen.getByLabelText('Smartcard number'), '1234560000');
    expect(await screen.findByText("We couldn't find that smartcard with DStv")).toBeTruthy();
  });

  it('lists plans for a valid smartcard and marks the current one', async () => {
    await render(wrap(bank(), <UtilityScreen category="cable_tv" />));
    await fireEvent.press(await screen.findByRole('togglebutton', { name: 'GOtv' }));
    await fireEvent.changeText(screen.getByLabelText('Smartcard number'), '1234567890');
    expect(await screen.findByText('Current plan: GOtv Max')).toBeTruthy();
    expect(screen.getByText('Current plan · Renew')).toBeTruthy();
  });
});
