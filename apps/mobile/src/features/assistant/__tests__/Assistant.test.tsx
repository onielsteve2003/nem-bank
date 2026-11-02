import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components';
import { ApiError, RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { SUGGESTIONS, assistantProblem, revealed, useAssistantStore } from '../assistant';
import { AssistantScreen } from '../screens/AssistantScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), dismissTo: jest.fn() }),
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

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
    expect(screen.getByText(/\d+ transactions?/)).toBeOnTheScreen();

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
});
