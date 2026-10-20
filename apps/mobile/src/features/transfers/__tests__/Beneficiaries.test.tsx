import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { BeneficiariesScreen } from '../screens/BeneficiariesScreen';
import { useSendDraft } from '../sendDraft';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => ({}),
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

configure({ defaultIncludeHiddenElements: true });

const bank = () =>
  createMockRepositories({ store: createMemoryStore(), simulation: { latency: 'off' } });

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
              <BeneficiariesScreen />
            </ModalSheetHost>
          </ToastProvider>
        </ThemeProvider>
      </QueryProvider>
    </RepositoryProvider>
  </SafeAreaProvider>
);

const amaka = async (repos: Repositories) =>
  (await repos.beneficiaries.list()).data.find((b) => b.name === 'Amaka Obi')!;

beforeEach(() => {
  mockPush.mockClear();
  useSendDraft.getState().clear();
});

it('favourites, nicknames and pays a beneficiary', async () => {
  const repos = bank();
  const before = await amaka(repos);
  await render(wrap(repos));
  await fireEvent.press(await screen.findByRole('button', { name: /^Manage Amaka Obi/ }));

  await fireEvent.press(await screen.findByRole('switch', { name: 'Favourite' }));
  await waitFor(async () => expect((await amaka(repos)).favourite).toBe(!before.favourite));

  await fireEvent.press(screen.getByRole('button', { name: /nickname/ }));
  await fireEvent.changeText(screen.getByLabelText(/^Nickname/), '  Ama  ');
  await fireEvent.press(screen.getByRole('button', { name: 'Save nickname' }));
  await waitFor(async () => expect((await amaka(repos)).nickname).toBe('Ama'));

  await fireEvent.press(screen.getByRole('button', { name: 'Pay Ama' }));
  expect(mockPush).toHaveBeenCalledWith('/send/amount');
  expect(useSendDraft.getState().recipient?.name).toBe('Ama');
});

it('deletes a beneficiary after confirming', async () => {
  const repos = bank();
  await render(wrap(repos));
  await fireEvent.press(await screen.findByRole('button', { name: /^Manage Amaka Obi/ }));
  await fireEvent.press(await screen.findByRole('button', { name: /^Delete Amaka/ }));
  await fireEvent.press(await screen.findByRole('button', { name: 'Delete' }));
  await waitFor(async () => expect(await amaka(repos)).toBeUndefined());
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /^Manage Amaka Obi/ })).toBeNull(),
  );
});

it('marks someone just saved as still in the cooling-off', async () => {
  const repos = bank();
  await repos.beneficiaries.create({
    body: {
      destination: {
        kind: 'bank',
        bank_code: '058',
        account_number: '0123456789',
        account_name: 'Chidi Okonkwo',
      },
    },
  });
  await render(wrap(repos));
  expect(
    await screen.findByRole('button', {
      name: /^Manage Chidi Okonkwo.*new, large payments need an extra check until/,
    }),
  ).toBeTruthy();
  expect(screen.getByText(/^New · /)).toBeTruthy();
});
