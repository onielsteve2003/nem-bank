import type { Schema } from '@nem/contracts';
import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen } from '@testing-library/react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
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
jest.mock('react-native-view-shot', () => ({
  captureRef: jest.fn(async () => 'file:///receipt.png'),
}));
jest.mock('expo-print', () => ({
  printToFileAsync: jest.fn(async () => ({ uri: 'file:///r.pdf' })),
}));
jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(async () => undefined) }));

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
  await fireEvent.press(await screen.findByRole('checkbox', { name: /Always categorise/ }));
  const target = t.category === 'shopping' ? 'Groceries' : 'Shopping';
  await fireEvent.press(screen.getByRole('button', { name: target }));
  expect(
    await screen.findByRole('button', { name: `Category: ${target}. Set by you` }),
  ).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Send again' }));
  expect(mockPush).toHaveBeenCalledWith({ pathname: '/send', params: { repeat: t.transfer_id } });
  await fireEvent.press(screen.getByRole('button', { name: 'Report a problem' }));
  expect(mockPush).toHaveBeenCalledWith({
    pathname: '/disputes/new',
    params: { transaction: t.id },
  });
}, 20_000);

it('shares the receipt as an image and as a PDF', async () => {
  const repos = createMockRepositories({
    store: createMemoryStore(),
    simulation: { latency: 'off' },
  });
  const [first] = (await repos.transactions.list({ query: { limit: 1 } })).data;
  const receipt = (await repos.transactions.getReceipt({
    path: { transaction_id: first!.id },
  })) as Schema<'Receipt'>;
  mockId = first!.id;
  await renderDetail(repos);

  await fireEvent.press(await screen.findByRole('button', { name: 'Share receipt' }));
  expect(await screen.findByText(receipt.verification_code)).toBeTruthy();

  await fireEvent.press(screen.getByRole('button', { name: 'Share as image' }));
  expect(Sharing.shareAsync).toHaveBeenLastCalledWith(
    'file:///receipt.png',
    expect.objectContaining({ mimeType: 'image/png' }),
  );

  await fireEvent.press(screen.getByRole('button', { name: 'Share as PDF' }));
  const html = (Print.printToFileAsync as jest.Mock).mock.calls[0][0].html as string;
  expect(html).toContain(receipt.reference);
  expect(Sharing.shareAsync).toHaveBeenLastCalledWith(
    'file:///r.pdf',
    expect.objectContaining({ mimeType: 'application/pdf' }),
  );
}, 20_000);

it('shows how sure a smart guess is and lets the customer confirm an unsure one', async () => {
  const repos = createMockRepositories({
    store: createMemoryStore(),
    simulation: { latency: 'off' },
  });
  const cards = await repos.transactions.list({ query: { type: ['card_payment'], limit: 100 } });
  const unsure = cards.data.find(
    (c) => c.category_source === 'model' && (c.category_confidence ?? 1) < 0.65,
  )!;
  expect(unsure).toBeDefined();
  mockId = unsure.id;
  await renderDetail(repos);

  expect(await screen.findByText(/Smart guess · Not sure \(\d+%\)/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'AI: Smart categories' })).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: "Yes, that's right" }));
  expect(await screen.findByText('Thanks, Nem will remember')).toBeTruthy();
  expect(await screen.findByText('Set by you')).toBeTruthy();
  expect(screen.queryByRole('button', { name: "Yes, that's right" })).toBeNull();

  // The answer is a merchant rule: other payments there are now set by the customer too.
  const after = await repos.transactions.list({ query: { type: ['card_payment'], limit: 100 } });
  const same = after.data.filter((c) => c.counterparty.name === unsure.counterparty.name);
  expect(same.every((c) => c.category_source === 'user')).toBe(true);
}, 20_000);
