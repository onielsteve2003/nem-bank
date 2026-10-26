import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { PayScreen } from '../screens/PayScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn() }),
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

configure({ defaultIncludeHiddenElements: true });

const bank = () =>
  createMockRepositories({
    store: createMemoryStore(),
    clock: () => new Date(Date.now()),
    simulation: { latency: 'off' },
  });

const wrap = (repos: Repositories) => (
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
            <ModalSheetHost>
              <PayScreen />
            </ModalSheetHost>
          </ToastProvider>
        </ThemeProvider>
      </QueryProvider>
    </RepositoryProvider>
  </SafeAreaProvider>
);

beforeEach(() => mockPush.mockClear());

describe('Pay tab', () => {
  it('opens every quick action and bills', async () => {
    await render(wrap(bank()));
    for (const [label, path] of [
      ['Send', '/send'],
      ['Scan QR', '/qr'],
      ['Request', '/send/request'],
      ['Split', '/send/splits'],
      ['Links', '/send/links'],
      ['Scheduled', '/send/scheduled'],
    ]) {
      await fireEvent.press(screen.getByRole('button', { name: label }));
      expect(mockPush).toHaveBeenLastCalledWith(path);
    }
    await fireEvent.press(screen.getByText('Pay bills'));
    expect(mockPush).toHaveBeenLastCalledWith('/bills');
  });

  it('shows saved people and requests waiting to be paid', async () => {
    await render(wrap(bank()));
    expect(await screen.findByText('Waiting for you')).toBeTruthy();
    const person = (await screen.findAllByRole('button', { name: /^Pay [A-Z]/ }))[0]!;
    await fireEvent.press(person);
    expect(mockPush).toHaveBeenLastCalledWith('/send/amount');
  });
});
