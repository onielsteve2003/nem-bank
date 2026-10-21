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

import { bankCardProps, cardFacts, cardName } from '../cards';
import { CardsScreen } from '../screens/CardsScreen';
import { NewCardScreen } from '../screens/NewCardScreen';

const mockPush = jest.fn();
const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: mockBack, replace: jest.fn() }),
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

  it('says so when there are no cards', async () => {
    const base = bank();
    const repos = { ...base, cards: { ...base.cards, list: async () => ({ data: [] }) } };
    await render(wrap(repos, <CardsScreen />));
    expect(await screen.findByText('No cards yet')).toBeTruthy();
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
