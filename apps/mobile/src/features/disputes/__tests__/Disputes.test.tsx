import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { descriptionProblem, isOpen, nextStep } from '../disputes';
import { DisputeScreen } from '../screens/DisputeScreen';
import { DisputesScreen } from '../screens/DisputesScreen';
import { NewDisputeScreen } from '../screens/NewDisputeScreen';

const mockParams: { id?: string; transaction?: string } = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(async () => ({
    canceled: false,
    assets: [{ base64: 'aGVsbG8=', mimeType: 'image/png' }],
  })),
}));

configure({ defaultIncludeHiddenElements: true });

const bank = () =>
  createMockRepositories({
    store: createMemoryStore(),
    clock: () => new Date(),
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

/** A completed payment out of the account, the kind you can dispute. */
const disputable = async (repos: Repositories) => {
  const page = await repos.transactions.list({ query: { limit: 50 } });
  for (const t of page.data) {
    const detail = await repos.transactions.get({ path: { transaction_id: t.id } });
    if (detail.can_dispute) return detail;
  }
  throw new Error('no disputable transaction in the seed');
};

describe('dispute rules', () => {
  it('asks for at least 10 characters', () => {
    expect(descriptionProblem('too short')).toBe('Tell us a little more (1 more character)');
    expect(descriptionProblem('This was charged twice today')).toBeUndefined();
  });

  it('knows when a case is open and what comes next', () => {
    expect(isOpen({ status: 'under_review', resolved_at: null })).toBe(true);
    expect(isOpen({ status: 'withdrawn', resolved_at: null })).toBe(false);
    expect(isOpen({ status: 'resolved_refunded', resolved_at: '2026-11-02T10:00:00Z' })).toBe(
      false,
    );
    expect(nextStep({ status: 'submitted' } as never)).toBe('A specialist will pick it up shortly');
    expect(nextStep({ status: 'withdrawn' } as never)).toBeUndefined();
  });
});

describe('NewDisputeScreen', () => {
  it('reports a payment with a photo and gives a case number', async () => {
    const repos = bank();
    const txn = await disputable(repos);
    mockParams.transaction = txn.id;
    await render(wrap(repos, <NewDisputeScreen />));
    const send = await screen.findByRole('button', { name: 'Send report' });
    expect(send).toBeDisabled();
    await fireEvent.press(screen.getByRole('radio', { name: 'I was charged twice' }));
    await fireEvent.changeText(
      screen.getByLabelText('What happened'),
      'The same payment left my account twice',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Choose photo' }));
    expect(await screen.findByLabelText('Evidence photo 1')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Send report' }));

    expect(await screen.findByText('We’ve got it')).toBeOnTheScreen();
    expect(screen.getByText(/^DSP-\d{8}$/)).toBeOnTheScreen();
    const [dispute] = (await repos.disputes.list()).data;
    expect(dispute).toMatchObject({ reason: 'duplicate_charge', transaction_id: txn.id });
    expect(dispute!.evidence).toHaveLength(1);
  });
});

describe('DisputeScreen and tracker', () => {
  it('shows the timeline and lets you withdraw', async () => {
    const repos = bank();
    const txn = await disputable(repos);
    const d = await repos.disputes.create({
      body: {
        transaction_id: txn.id,
        reason: 'wrong_amount',
        description: 'I paid more than agreed',
      },
    });
    mockParams.id = d.id;
    await render(wrap(repos, <DisputeScreen />));
    expect(await screen.findByText('Dispute received')).toBeOnTheScreen();
    expect(screen.getByText('Received')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Withdraw dispute' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Withdraw' }));
    await waitFor(async () =>
      expect((await repos.disputes.get({ path: { dispute_id: d.id } })).status).toBe('withdrawn'),
    );
  });

  it('explains how to start a dispute when there are none', async () => {
    await render(wrap(bank(), <DisputesScreen />));
    expect(await screen.findByText('No disputes')).toBeOnTheScreen();
  });
});
