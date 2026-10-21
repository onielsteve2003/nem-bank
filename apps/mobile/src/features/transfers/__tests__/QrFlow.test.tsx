import { QueryClient } from '@tanstack/react-query';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { sha256Hex } from '@/data/mock/documents';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { typedFromKobo } from '../amount';
import { classifyScan, countdown } from '../qr';
import { QrScreen } from '../screens/QrScreen';
import { useSendDraft } from '../sendDraft';

const mockPush = jest.fn();
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

// The camera is a native view; the test plays the part of a code coming into view.
let mockScan: ((event: { data: string }) => void) | undefined;
let mockPermission = { granted: true, canAskAgain: true };
const mockRequest = jest.fn();
jest.mock('expo-camera', () => ({
  CameraView: (props: { onBarcodeScanned?: (event: { data: string }) => void }) => {
    mockScan = props.onBarcodeScanned;
    return null;
  },
  useCameraPermissions: () => [mockPermission, mockRequest],
}));

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

/** A code the mock bank signed for Emeka, as his phone would show it. */
async function emekaCode(repos: Repositories, amountMinor?: string) {
  const emeka = await repos.payees.resolve({ body: { kind: 'nem', query: '@emeka' } });
  const expires = amountMinor ? new Date(Date.now() + 15 * 60_000).toISOString() : '-';
  const body = ['NEMQR1', emeka.account_number, amountMinor ?? '-', expires].join('|');
  return `${body}|${sha256Hex(`nem-mock-qr-key|${body}`).slice(0, 24)}`;
}

async function scan(text: string) {
  await waitFor(() => expect(mockScan).toBeDefined());
  await act(async () => mockScan!({ data: text }));
}

beforeEach(() => {
  mockPush.mockClear();
  mockRequest.mockClear();
  mockScan = undefined;
  mockParams = {};
  mockPermission = { granted: true, canAskAgain: true };
  useSendDraft.getState().clear();
});

it('scans an open code, names the payee, then asks how much', async () => {
  const repos = bank();
  await render(wrap(repos, <QrScreen />));
  await scan(await emekaCode(repos));

  expect(await screen.findByText('Emeka Nwosu')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Pay Emeka' }));
  expect(useSendDraft.getState().recipient).toMatchObject({ kind: 'nem', name: 'Emeka Nwosu' });
  expect(mockPush).toHaveBeenCalledWith('/send/amount');
});

it('takes a code with an amount straight to review', async () => {
  const repos = bank();
  await render(wrap(repos, <QrScreen />));
  await scan(await emekaCode(repos, '250050'));

  await fireEvent.press(await screen.findByRole('button', { name: 'Pay ₦2,500.50' }));
  expect(useSendDraft.getState().amount).toBe('2500.5');
  expect(mockPush).toHaveBeenCalledWith('/send/review');
});

it('refuses a code that was changed after Nem signed it', async () => {
  const repos = bank();
  await render(wrap(repos, <QrScreen />));
  const genuine = await emekaCode(repos);
  await scan(genuine.replace('|-|-|', '|9999900|-|'));
  expect(await screen.findByText("This code isn't genuine")).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Scan again' }));
  expect(await screen.findByText('Point your camera at a Nem QR code.')).toBeTruthy();
});

it('opens a scanned pay link on its pay page', async () => {
  await render(wrap(bank(), <QrScreen />));
  await scan('https://nem-bank-fodx.vercel.app/pay/emeka-birthday');
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/pay/[slug]',
    params: { slug: 'emeka-birthday' },
  });
});

it("knows the customer's own code", async () => {
  const repos = bank();
  const ngn = (await repos.accounts.list()).data.find((a) => a.currency === 'NGN')!;
  const mine = await repos.paymentLinks.getMyQr({ query: { account_id: ngn.id } });
  mockParams = { payload: mine.payload };
  await render(wrap(repos, <QrScreen />));
  expect(await screen.findByText('This is your own code')).toBeTruthy();
});

it('asks for the camera before scanning, and offers pasting', async () => {
  mockPermission = { granted: false, canAskAgain: true };
  await render(wrap(bank(), <QrScreen />));
  await fireEvent.press(await screen.findByRole('button', { name: 'Allow camera' }));
  expect(mockRequest).toHaveBeenCalled();

  await fireEvent.changeText(screen.getByLabelText(/^Or paste a code/), 'hello');
  await fireEvent.press(screen.getByRole('button', { name: 'Check code' }));
  expect(await screen.findByText("That isn't a Nem code")).toBeTruthy();
});

it('shows my code, and a 15-minute code once an amount is asked for', async () => {
  mockParams = { mode: 'mine' };
  await render(wrap(bank(), <QrScreen />));
  expect(await screen.findByLabelText('Your QR code to receive money')).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Ask for an amount' }));
  for (const key of ['3', '0', '0', '0']) {
    await fireEvent.press(screen.getAllByRole('button', { name: key }).at(-1)!);
  }
  await fireEvent.press(screen.getByRole('button', { name: 'Show code for ₦3,000.00' }));
  expect(await screen.findByLabelText('Your QR code asking for ₦3,000.00')).toBeTruthy();
  expect(screen.getByText(/New code in 1[45]:\d\d/)).toBeTruthy();
});

describe('QR helpers', () => {
  it('tells Nem codes, pay links and anything else apart', () => {
    expect(classifyScan('NEMQR1|0123456789|-|-|sig')).toEqual({
      kind: 'nem_qr',
      payload: 'NEMQR1|0123456789|-|-|sig',
    });
    expect(classifyScan(' nembank://pay/abc123 ')).toEqual({
      kind: 'pay_link',
      url: 'nembank://pay/abc123',
    });
    expect(classifyScan('https://example.com/pay/abc')).toEqual({ kind: 'other' });
    expect(classifyScan('WIFI:S:home;;')).toEqual({ kind: 'other' });
  });

  it('turns kobo back into what the keypad types', () => {
    expect(typedFromKobo(500_000n)).toBe('5000');
    expect(typedFromKobo(250_050n)).toBe('2500.5');
    expect(typedFromKobo(250_005n)).toBe('2500.05');
    expect(typedFromKobo(99n)).toBe('0.99');
  });

  it('counts down to the minute and second, never below zero', () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    expect(countdown('2026-10-21T12:15:00Z', now)).toBe('15:00');
    expect(countdown('2026-10-21T12:00:09Z', now)).toBe('0:09');
    expect(countdown('2026-10-21T11:59:00Z', now)).toBe('0:00');
  });
});
