import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components';
import { ApiError, RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories, DEMO_PIN } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import {
  SUGGESTIONS,
  actionStatus,
  assistantProblem,
  expiresIn,
  revealed,
  useAssistantStore,
  type PreparedAction,
} from '../assistant';
import { AssistantScreen } from '../screens/AssistantScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), dismissTo: jest.fn() }),
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

const wrap = (repos: Repositories) => (
  <SafeAreaProvider
    initialMetrics={{
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 47, left: 0, right: 0, bottom: 34 },
    }}
  >
    <RepositoryProvider repositories={repos}>
      <QueryProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider initialPreference="dark">
          <ToastProvider>
            <AssistantScreen />
          </ToastProvider>
        </ThemeProvider>
      </QueryProvider>
    </RepositoryProvider>
  </SafeAreaProvider>
);

const bank = () =>
  createMockRepositories({
    store: createMemoryStore(),
    clock: () => new Date(),
    simulation: { latency: 'off' },
  });

const problemOf = (status: number, code: string) =>
  new ApiError({ type: 'about:blank', title: code, status, code });

beforeEach(() => {
  jest.clearAllMocks();
  useAssistantStore.setState({ conversationId: null });
});

describe('assistant rules', () => {
  it('reveals whole words over time and ends on the full reply', () => {
    const text = 'You have ₦12,000 available';
    expect(revealed(text, 0)).toBe('You');
    expect(revealed(text, 45)).toBe('You have');
    expect(revealed(text, 10_000)).toBe(text);
  });

  it('tells apart off, unavailable, busy and a lost chat', () => {
    expect(assistantProblem(problemOf(403, 'feature_disabled'))).toBe('off');
    expect(assistantProblem(problemOf(503, 'assistant_unavailable'))).toBe('unavailable');
    expect(assistantProblem(problemOf(429, 'rate_limited'))).toBe('busy');
    expect(assistantProblem(problemOf(404, 'not_found'))).toBe('gone');
    expect(assistantProblem(new Error('x'))).toBe('other');
  });

  it('treats a prepared action past its time as expired', () => {
    const now = new Date('2026-11-02T10:00:00Z');
    const a = {
      status: 'prepared',
      expires_at: '2026-11-02T10:04:30Z',
    } as PreparedAction;
    expect(actionStatus(a, now)).toBe('prepared');
    expect(expiresIn(a, now)).toBe('Expires in 5 min');
    expect(actionStatus(a, new Date('2026-11-02T10:05:00Z'))).toBe('expired');
    expect(actionStatus({ ...a, status: 'confirmed' }, new Date('2026-11-03'))).toBe('confirmed');
  });
});

describe('AssistantScreen', () => {
  it('greets, answers a suggestion, and keeps the chat for next time', async () => {
    const repos = bank();
    const first = await render(wrap(repos));
    expect(await screen.findByText(/What can I help with\?/)).toBeOnTheScreen();
    for (const s of SUGGESTIONS) expect(screen.getByText(s)).toBeOnTheScreen();

    await fireEvent.press(screen.getByText("What's my balance?"));
    expect(await screen.findByLabelText(/You have ₦[\d,.]+ available/)).toBeOnTheScreen();
    // Starters are for an empty chat only.
    expect(screen.queryByText('Freeze my card')).toBeNull();
    const id = useAssistantStore.getState().conversationId;
    expect(id).not.toBeNull();

    await first.unmount();
    await render(wrap(repos));
    expect(await screen.findByText("What's my balance?")).toBeOnTheScreen();
    expect(useAssistantStore.getState().conversationId).toBe(id);
  });

  it('types a question and starts a new chat on request', async () => {
    const repos = bank();
    await render(wrap(repos));
    await screen.findByText(/What can I help with\?/);
    await fireEvent.changeText(
      screen.getByLabelText('Ask the assistant'),
      'Show my recent transactions',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByLabelText('Here are your latest transactions.')).toBeOnTheScreen();

    const before = useAssistantStore.getState().conversationId;
    await fireEvent.press(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(() => expect(useAssistantStore.getState().conversationId).not.toBe(before));
    expect(await screen.findByText('Freeze my card')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Here are your latest transactions.')).toBeNull();
  });

  it('offers the shortcuts and the setting when the assistant is off', async () => {
    const repos = bank();
    const prefs = await repos.users.getPreferences();
    await repos.users.setPreferences({ body: { ...prefs, ai: { ...prefs.ai, assistant: false } } });
    await render(wrap(repos));
    expect(await screen.findByText('The assistant is off')).toBeOnTheScreen();
    expect(screen.getByText('Send money')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'AI and your data' }));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/ai/[feature]',
      params: { feature: 'assistant' },
    });
  });

  it('starts over when the bank no longer has the saved chat', async () => {
    useAssistantStore.setState({ conversationId: '00000000-0000-0000-0000-000000000000' });
    await render(wrap(bank()));
    expect(await screen.findByText(/What can I help with\?/)).toBeOnTheScreen();
  });

  const ask = async (question: string) => {
    await screen.findByText(/What can I help with\?/);
    await fireEvent.changeText(screen.getByLabelText('Ask the assistant'), question);
    await fireEvent.press(screen.getByRole('button', { name: 'Ask' }));
  };

  it('draws the spending chart the assistant sends back', async () => {
    await render(wrap(bank()));
    await ask('How much did I spend this month?');
    expect(await screen.findByText('Spending by category')).toBeOnTheScreen();
  });

  it('prepares a transfer, confirms it with the PIN and opens the result', async () => {
    const repos = bank();
    await render(wrap(repos));
    await ask('Send ₦5,000 to @amaka_o');
    expect(await screen.findByText('Send ₦5,000.00 to Amaka Obi (@amaka_o)')).toBeOnTheScreen();
    expect(screen.getByText(/Nothing moves until you confirm/)).toBeOnTheScreen();
    expect(screen.getByText('Total from your account')).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    for (const digit of DEMO_PIN) {
      await fireEvent.press((await screen.findAllByRole('button', { name: digit })).at(-1)!);
    }
    await waitFor(() =>
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/send/result/[id]',
        params: { id: expect.any(String) },
      }),
    );
    expect(await screen.findByText('Done')).toBeOnTheScreen();
    const { id } = mockPush.mock.calls.at(-1)![0].params;
    expect((await repos.transfers.get({ path: { transfer_id: id } })).id).toBe(id);
  });

  it('cancels a prepared card freeze without touching the card', async () => {
    const repos = bank();
    const frozen = async () =>
      (await repos.cards.list()).data.filter((c) => c.status === 'frozen').length;
    const before = await frozen();
    await render(wrap(repos));
    await ask('Freeze my card');
    await screen.findByText(/Freeze card ••••/);
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Cancelled. Nothing was sent.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(await frozen()).toBe(before);
  });
});
