import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories, DEMO_PIN } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { FRIEND_AJO_CODE } from '@/data/mock/seedWorld';
import { ThemeProvider } from '@/theme';

import { AjoInviteScreen } from '../screens/AjoInviteScreen';
import { inviteCodeOf } from '../screens/AjoListScreen';

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: jest.fn() }),
  useLocalSearchParams: () => ({}),
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

describe('ajo invites', () => {
  const pin = async () => {
    for (const digit of DEMO_PIN) {
      await fireEvent.press((await screen.findAllByRole('button', { name: digit })).at(-1)!);
    }
  };

  it('reads a code from a pasted link or the code itself', () => {
    expect(inviteCodeOf('https://nem-bank-fodx.vercel.app/ajo/yaba04')).toBe('YABA04');
    expect(inviteCodeOf(' YABA04 ')).toBe('YABA04');
    expect(inviteCodeOf('nope')).toBeNull();
  });

  it("joins a friend's ajo from its invite with the PIN", async () => {
    const repos = bank();
    expect((await repos.ajo.listGroups()).data).toHaveLength(1);
    await render(wrap(repos, <AjoInviteScreen code={FRIEND_AJO_CODE} />));
    expect(await screen.findByText('Yaba Tech Bros')).toBeTruthy();
    expect(screen.getByText('Members · 1 place left')).toBeTruthy();
    await fireEvent.press(screen.getByText(/I'll pay ₦10,000 a month/));
    await fireEvent.press(screen.getByRole('button', { name: 'Join ajo' }));
    await pin();
    await waitFor(async () => expect((await repos.ajo.listGroups()).data).toHaveLength(2));
    expect(mockReplace).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/ajo/group/[id]' }),
    );
    await expect(
      repos.ajo.acceptInvite({
        path: { invite_code: FRIEND_AJO_CODE },
        body: { source_account_id: (await repos.accounts.list()).data[0]!.id },
        idempotencyKey: 'again',
      }),
    ).rejects.toMatchObject({ problem: { code: 'already_member' } });
  });
});
