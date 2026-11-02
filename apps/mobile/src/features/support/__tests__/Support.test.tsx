import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type RealtimeSource, type Repositories } from '@/data';
import { createMockBank, createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { ChatScreen } from '../screens/ChatScreen';
import { NewChatScreen } from '../screens/NewChatScreen';
import { SupportScreen } from '../screens/SupportScreen';
import { messageBody } from '../support';

const mockParams: { id?: string; transaction?: string } = {};
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace, back: jest.fn() }),
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

const options = () => ({
  store: createMemoryStore(),
  clock: () => new Date(),
  simulation: { latency: 'off' as const },
});

const wrap = (repos: Repositories, ui: React.ReactElement, realtime?: RealtimeSource) => (
  <SafeAreaProvider
    initialMetrics={{
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 47, left: 0, right: 0, bottom: 34 },
    }}
  >
    <RepositoryProvider repositories={repos} realtime={realtime}>
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

describe('support rules', () => {
  it('always sends a body, even with only photos', () => {
    expect(messageBody('  hello ', 2)).toBe('hello');
    expect(messageBody('', 1)).toBe('Sent a photo');
    expect(messageBody(' ', 3)).toBe('Sent 3 photos');
    expect(messageBody('', 0)).toBe('');
  });
});

describe('mock agent typing', () => {
  it('types after your message, then replies and stops typing', async () => {
    let now = Date.parse('2026-11-02T10:00:00Z');
    const bank = createMockBank({ ...options(), clock: () => new Date(now) });
    const c = await bank.repositories.support.startConversation({
      body: { subject: 'My card', message: 'My card was charged twice' },
    });
    now += 2_000;
    const typing = await bank.pulse();
    expect(typing).toContainEqual(
      expect.objectContaining({
        type: 'support.typing',
        data: { conversation_id: c.id, sender: 'agent', typing: true },
      }),
    );
    now += 4_000;
    const reply = await bank.pulse();
    expect(reply.map((e) => e.type)).toEqual(
      expect.arrayContaining(['support.message', 'support.typing']),
    );
    expect(reply.find((e) => e.type === 'support.typing')?.data).toMatchObject({ typing: false });
  });
});

describe('support screens', () => {
  it('lists your chats, then starts one with a topic', async () => {
    const repos = createMockRepositories(options());
    await render(wrap(repos, <SupportScreen />));
    expect(await screen.findByText('Welcome to Nem')).toBeOnTheScreen();
    expect(screen.getByText('Closed')).toBeOnTheScreen();

    await render(wrap(repos, <NewChatScreen />));
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'My card' }));
    await fireEvent.changeText(screen.getByLabelText('Your message'), 'My card is not working');
    await fireEvent.press(send);
    await waitFor(() => expect(mockReplace).toHaveBeenCalled());
    const [c] = (await repos.support.listConversations()).data;
    expect(c).toMatchObject({ subject: 'My card', status: 'open' });
  });

  it('sends a message with a photo and shows the agent typing', async () => {
    const bank = createMockBank(options());
    const repos = bank.repositories;
    const c = await repos.support.startConversation({
      body: { subject: 'A transfer', message: 'Where is my money?' },
    });
    mockParams.id = c.id;
    const listeners = new Set<Parameters<RealtimeSource['subscribe']>[0]>();
    const realtime: RealtimeSource = {
      subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
      status: () => 'open',
      onStatus: () => () => undefined,
    };
    await render(wrap(repos, <ChatScreen />, realtime));
    expect(await screen.findByText('Where is my money?')).toBeOnTheScreen();

    await fireEvent.press(screen.getByRole('button', { name: 'Add a photo' }));
    expect(await screen.findByLabelText('Photo 1 to send')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Message'), 'Here is the receipt');
    await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Here is the receipt')).toBeOnTheScreen();
    const messages = (await repos.support.listMessages({ path: { conversation_id: c.id } })).data;
    expect(messages[0]!.attachments).toHaveLength(1);

    for (const l of listeners)
      l({
        id: 'e1',
        type: 'support.typing',
        occurred_at: new Date().toISOString(),
        data: { conversation_id: c.id, sender: 'agent', typing: true },
      });
    expect(await screen.findByLabelText('Support is typing')).toBeOnTheScreen();
  });
});
