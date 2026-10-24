import type { Schema } from '@nem/contracts';
import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories, DEMO_PIN } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import * as Clipboard from 'expo-clipboard';

import { bankCardProps, cardFacts, cardName, groupPan } from '../cards';
import { CardsScreen } from '../screens/CardsScreen';
import { NewCardScreen } from '../screens/NewCardScreen';

const mockPush = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack, replace: jest.fn() }),
  useFocusEffect: jest.fn(),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('expo-screen-capture', () => ({
  preventScreenCaptureAsync: jest.fn(async () => undefined),
  allowScreenCaptureAsync: jest.fn(async () => undefined),
}));
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

/** The PIN pad is the last keypad rendered. */
const enterPin = async () => {
  for (const k of DEMO_PIN)
    await fireEvent.press(screen.getAllByRole('button', { name: k }).at(-1)!);
};

const CARD = {
  id: 'c1',
  currency: 'USD',
  type: 'merchant_locked',
  status: 'active',
  network: 'nem_visa',
  last4: '4821',
  expiry_month: 3,
  expiry_year: 2030,
  name_on_card: 'TOLU ADEBAYO',
  nickname: null,
  design: 'mint',
  physical: false,
  controls: {
    spend_limit: { amount: { amount_minor: '2000', currency: 'USD' }, period: 'monthly' },
    online_enabled: true,
    international_enabled: true,
    merchant_lock: { merchant_id: 'mer_netflix', merchant_name: 'Netflix' },
  },
} as unknown as Schema<'Card'>;

beforeEach(() => {
  mockPush.mockClear();
  mockBack.mockClear();
});

describe('card copy', () => {
  it('groups a card number in fours', () => {
    expect(groupPan('5060991234567890')).toBe('5060 9912 3456 7890');
  });

  it('draws the simulated network as its brand with a two-digit expiry', () => {
    expect(bankCardProps(CARD)).toMatchObject({
      network: 'visa',
      expiry: '03/30',
      design: 'mint',
      frozen: false,
    });
  });

  it('names an unnamed card by its type and lists its lock and limit', () => {
    expect(cardName(CARD)).toBe('Merchant-locked card');
    expect(cardFacts(CARD)).toEqual([
      'Merchant-locked · USD · ends 4821',
      'Only works at Netflix',
      'Limit $20 a month',
    ]);
  });
});

describe('cards home', () => {
  it('shows the demo card with what it is for, and opens the create flow', async () => {
    await render(wrap(bank(), <CardsScreen />));
    expect(await screen.findByText('Everyday')).toBeTruthy();
    expect(screen.getByText(/^Standard · NGN · ends \d{4}$/)).toBeTruthy();
    expect(screen.getByText('Limit ₦200,000 a day')).toBeTruthy();
    expect(
      screen.getByLabelText(/^Virtual Verve card ending \d{4}, TOLULOPE ADEBAYO/),
    ).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Create a virtual card' }));
    expect(mockPush).toHaveBeenCalledWith('/new-card');
  });

  it('pages between cards with the dots', async () => {
    const repos = bank();
    const { data } = await repos.accounts.list();
    await repos.cards.create({
      body: { account_id: data[0]!.id, type: 'single_use', nickname: 'Trial', design: 'coral' },
      idempotencyKey: 'card-1',
    });
    await render(wrap(repos, <CardsScreen />));
    expect(await screen.findByText('Trial')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Show card 2 of 2' }));
    expect(await screen.findByText('Everyday')).toBeTruthy();
  });

  it('shows the details after the PIN, copies them, and hides them after 30 s', async () => {
    const repos = bank();
    await render(wrap(repos, <CardsScreen />));
    await fireEvent.press(await screen.findByRole('button', { name: 'Show card details' }));
    await enterPin();

    const number = await screen.findByLabelText(/^Card number: \d{4} \d{4} \d{4} \d{4}$/);
    expect(screen.getByLabelText(/^CVV: \d{3}$/)).toBeTruthy();
    expect(screen.getByText(/^Hiding in \d+ s/)).toBeTruthy();
    const pan = number.props.accessibilityLabel.replace('Card number: ', '').replaceAll(' ', '');
    await fireEvent.press(screen.getByRole('button', { name: 'Copy card number' }));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(pan);

    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    await waitFor(() => expect(screen.queryByLabelText(/^Card number:/)).toBeNull());
    expect(screen.getByRole('button', { name: 'Show card details' })).toBeTruthy();
    clock.mockRestore();
  });

  it('keeps the details hidden after a wrong PIN', async () => {
    const repos = bank();
    await render(wrap(repos, <CardsScreen />));
    await fireEvent.press(await screen.findByRole('button', { name: 'Show card details' }));
    const wrong = '1111'; // not the demo PIN
    for (const k of wrong)
      await fireEvent.press(screen.getAllByRole('button', { name: k }).at(-1)!);
    expect(await screen.findByText(/attempts? left|Wrong PIN|isn't right/i)).toBeTruthy();
    expect(screen.queryByLabelText(/^Card number:/)).toBeNull();
  });

  it('says so when there are no cards', async () => {
    const base = bank();
    const repos = { ...base, cards: { ...base.cards, list: async () => ({ data: [] }) } };
    await render(wrap(repos, <CardsScreen />));
    expect(await screen.findByText('No cards yet')).toBeTruthy();
  });
});

describe('card controls', () => {
  it('freezes and unfreezes the card', async () => {
    const repos = bank();
    await render(wrap(repos, <CardsScreen />));
    await fireEvent.press(await screen.findByRole('switch', { name: 'Freeze card' }));
    expect(await screen.findByText('Card frozen')).toBeTruthy();
    expect((await repos.cards.list()).data[0]!.status).toBe('frozen');
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Freeze card' })).toBeChecked());
    await fireEvent.press(screen.getByRole('switch', { name: 'Freeze card' }));
    expect(await screen.findByText('Card unfrozen')).toBeTruthy();
    expect((await repos.cards.list()).data[0]!.status).toBe('active');
  });

  it('turns international payments on', async () => {
    const repos = bank();
    await render(wrap(repos, <CardsScreen />));
    const before = (await repos.cards.list()).data[0]!.controls.international_enabled;
    await fireEvent.press(await screen.findByRole('switch', { name: 'International payments' }));
    await waitFor(async () =>
      expect((await repos.cards.list()).data[0]!.controls.international_enabled).toBe(!before),
    );
  });

  it('sets a monthly spend limit', async () => {
    const repos = bank();
    await render(wrap(repos, <CardsScreen />));
    await fireEvent.press(await screen.findByRole('button', { name: /^Spend limit/ }));
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'A month' }));
    await fireEvent.changeText(screen.getByLabelText('Limit in NGN'), '0');
    expect(screen.getByRole('button', { name: 'Save limit' })).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Limit in NGN'), '75,000');
    await fireEvent.press(screen.getByRole('button', { name: 'Save limit' }));
    expect(await screen.findByText('Spend limit saved')).toBeTruthy();
    expect((await repos.cards.list()).data[0]!.controls.spend_limit).toEqual({
      period: 'monthly',
      amount: { amount_minor: '7500000', currency: 'NGN' },
    });
  });

  it('locks a standard card to one merchant', async () => {
    const repos = bank();
    await render(wrap(repos, <CardsScreen />));
    await fireEvent.press(await screen.findByRole('button', { name: /^Merchant lock/ }));
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Jumia' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Locked to Jumia')).toBeTruthy();
    expect((await repos.cards.list()).data[0]!.controls.merchant_lock?.merchant_name).toBe('Jumia');
  });

  it('keeps a panic-frozen card frozen and says why', async () => {
    const repos = bank();
    await repos.security.activatePanic();
    await render(wrap(repos, <CardsScreen />));
    await fireEvent.press(await screen.findByRole('switch', { name: 'Freeze card' }));
    expect(await screen.findByText(/Releasing it unfreezes every card/)).toBeTruthy();
    expect((await repos.cards.list()).data[0]!.status).toBe('frozen');
  });
});

describe('card payments', () => {
  it('holds a pending payment, then settles it into a transaction when due', async () => {
    let now = Date.now();
    const repos = createMockRepositories({
      store: createMemoryStore(),
      clock: () => new Date(now),
      simulation: { latency: 'off' },
    });
    const card = (await repos.cards.list()).data[0]!;
    const payments = async () =>
      (await repos.cards.listTransactions({ path: { card_id: card.id } })).data;
    const bolt = (await payments()).find((p) => p.merchant.name === 'Bolt')!;
    expect(bolt).toMatchObject({ status: 'authorized', settled_at: null, transaction_id: null });

    now += 4 * 60_000;
    const after = await payments();
    const settled = after.find((p) => p.merchant.name === 'Bolt')!;
    expect(settled).toMatchObject({ status: 'settled', authorized_at: bolt.authorized_at });
    expect(after.find((p) => p.merchant.name === 'Chicken Republic')!.status).toBe('authorized');
    const txn = await repos.transactions.get({
      path: { transaction_id: settled.transaction_id! },
    });
    expect(txn).toMatchObject({ card_id: card.id, amount: bolt.amount, type: 'card_payment' });
  });

  it('lists pending payments apart from settled ones', async () => {
    await render(wrap(bank(), <CardsScreen />));
    expect(
      await screen.findByText(/^Held from your balance until the merchant settles/),
    ).toBeTruthy();
    expect(screen.getByText('Settled')).toBeTruthy();
    expect(screen.getAllByText(/^Authorised /).length).toBe(2);
  });
});

describe('new card', () => {
  it('creates a merchant-locked card once a merchant is picked, after the PIN', async () => {
    const repos = bank();
    await render(wrap(repos, <NewCardScreen />));
    await fireEvent.press(await screen.findByRole('radio', { name: /^Merchant-locked/ }));
    const create = screen.getByRole('button', { name: 'Create card' });
    expect(create).toBeDisabled();

    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Spotify' }));
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Mint' }));
    await fireEvent.changeText(screen.getByLabelText('Card name'), 'Music');
    await waitFor(() => expect(create).toBeEnabled());
    await fireEvent.press(create);
    await screen.findByText('Enter your PIN');
    await enterPin();

    expect(await screen.findByText(/^Your card ending \d{4} is ready$/)).toBeTruthy();
    expect(mockBack).toHaveBeenCalled();
    const made = (await repos.cards.list()).data[0]!;
    expect(made).toMatchObject({
      type: 'merchant_locked',
      nickname: 'Music',
      design: 'mint',
      currency: 'NGN',
      controls: { merchant_lock: { merchant_id: 'mer_spotify', merchant_name: 'Spotify' } },
    });
  });
});
