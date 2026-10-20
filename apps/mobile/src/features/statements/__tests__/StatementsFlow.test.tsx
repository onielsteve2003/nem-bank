import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen } from '@testing-library/react-native';
import * as Print from 'expo-print';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { StatementScreen } from '../StatementScreen';
import { StatementsScreen } from '../StatementsScreen';

let mockParams: Record<string, string> = {};
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('react-native-view-shot', () => ({ captureRef: jest.fn() }));
jest.mock('expo-print', () => ({
  printToFileAsync: jest.fn(async () => ({ uri: 'file:///s.pdf' })),
}));
jest.mock('expo-sharing', () => ({ shareAsync: jest.fn(async () => undefined) }));

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
          new QueryClient({
            defaultOptions: {
              queries: { gcTime: Infinity, retry: false },
              mutations: { gcTime: Infinity },
            },
          })
        }
      >
        <ThemeProvider initialPreference="dark">
          <ToastProvider>{ui}</ToastProvider>
        </ThemeProvider>
      </QueryProvider>
    </RepositoryProvider>
  </SafeAreaProvider>
);

it('requests last month, then previews and shares the ready statement', async () => {
  const repos = createMockRepositories({
    store: createMemoryStore(),
    simulation: { latency: 'off' },
  });
  mockParams = {};
  await render(wrap(repos, <StatementsScreen />));

  await fireEvent.press(await screen.findByRole('button', { name: 'Get statement' }));
  const [call] = mockPush.mock.calls.at(-1)!;
  expect(call.pathname).toBe('/statements/[id]');

  // Exercise the custom-date rules on the same screen.
  await fireEvent.press(screen.getByRole('togglebutton', { name: 'Choose dates' }));
  await fireEvent.changeText(screen.getByLabelText('From'), '01/01/2020');
  await fireEvent.changeText(screen.getByLabelText('To'), '01/02/2021');
  expect(await screen.findByText('A statement covers up to 12 months')).toBeTruthy();

  screen.unmount();
  mockParams = { id: call.params.id };
  await render(wrap(repos, <StatementScreen />));
  expect(await screen.findByText(/Preparing your statement/)).toBeTruthy();
  expect(
    await screen.findByLabelText(
      'QR code that opens the verification page',
      {},
      { timeout: 8_000 },
    ),
  ).toBeTruthy();

  const share = await screen.findByRole('button', { name: 'Share PDF' });
  await screen.findByText(/transactions · in/);
  await fireEvent.press(share);
  const html = (Print.printToFileAsync as jest.Mock).mock.calls[0][0].html as string;
  expect(html).toContain('Account statement');
  expect(html).toMatch(/[0-9a-f]{64}/);
}, 30_000);
