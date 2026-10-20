import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { RecipientScreen } from '../screens/RecipientScreen';
import { SendHubScreen } from '../screens/SendHubScreen';
import { destinationOf, useSendDraft } from '../sendDraft';

let mockParams: Record<string, string> = {};
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, back: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

configure({ defaultIncludeHiddenElements: true });

const bank = () =>
  createMockRepositories({ store: createMemoryStore(), simulation: { latency: 'off' } });

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
          <ToastProvider>{ui}</ToastProvider>
        </ThemeProvider>
      </QueryProvider>
    </RepositoryProvider>
  </SafeAreaProvider>
);

beforeEach(() => {
  mockPush.mockClear();
  mockParams = {};
  useSendDraft.getState().clear();
});

describe('send hub', () => {
  it('starts a new payment on the chosen rail', async () => {
    await render(wrap(bank(), <SendHubScreen />));
    await fireEvent.press(screen.getByRole('button', { name: /To another bank/ }));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/send/recipient',
      params: { mode: 'bank' },
    });
  });

  it('pays a saved beneficiary straight from the list, favourites first', async () => {
    await render(wrap(bank(), <SendHubScreen />));
    const rows = await screen.findAllByRole('button', { name: /^Pay / });
    expect(rows[0]!.props.accessibilityLabel).toMatch(/favourite$/);

    await fireEvent.press(screen.getByRole('button', { name: /Pay Amaka Obi/ }));
    expect(mockPush).toHaveBeenCalledWith('/send/amount');
    const recipient = useSendDraft.getState().recipient!;
    expect(recipient.kind).toBe('nem');
    expect(destinationOf(recipient)).toEqual({
      kind: 'beneficiary',
      beneficiary_id: recipient.beneficiaryId,
    });
  });

  it('explains that sending abroad needs a partner', async () => {
    await render(wrap(bank(), <SendHubScreen />));
    await fireEvent.press(screen.getByRole('button', { name: /Send abroad/ }));
    expect(await screen.findByText(/licensed remittance partner/)).toBeTruthy();
  });
});

describe('recipient', () => {
  const continueButton = () => screen.getByRole('button', { name: 'Continue' });

  it('finds a Nem user by @nemtag and carries them into the payment', async () => {
    mockParams = { mode: 'nem' };
    await render(wrap(bank(), <RecipientScreen />));
    await fireEvent.changeText(screen.getByLabelText('@nemtag, phone or account number'), '@kunle');
    expect(await screen.findByText('Kunle Adeyemi')).toBeTruthy();
    expect(screen.getByText(/No fee between Nem users/)).toBeTruthy();

    await fireEvent.press(continueButton());
    expect(mockPush).toHaveBeenCalledWith('/send/amount');
    expect(useSendDraft.getState().recipient).toMatchObject({ kind: 'nem', nemtag: 'kunle' });
  });

  it('says so when no Nem user matches', async () => {
    mockParams = { mode: 'nem' };
    await render(wrap(bank(), <RecipientScreen />));
    await fireEvent.changeText(
      screen.getByLabelText('@nemtag, phone or account number'),
      'nobody_here',
    );
    expect(await screen.findByText(/No Nem user matches that/)).toBeTruthy();
    expect(continueButton()).toBeDisabled();
  });

  const payAtGtbank = async (name: string) => {
    mockParams = { mode: 'bank' };
    await render(wrap(bank(), <RecipientScreen />));
    await fireEvent.press(screen.getByRole('button', { name: /^Bank, / }));
    await fireEvent.changeText(await screen.findByLabelText('Search banks'), 'gtb');
    await fireEvent.press(await screen.findByRole('button', { name: 'Guaranty Trust Bank' }));
    await fireEvent.changeText(screen.getByLabelText('Account number'), '0123456789');
    await fireEvent.changeText(screen.getByLabelText('Name on the account'), name);
  };

  it('confirms the payee when the name matches the bank record', async () => {
    await payAtGtbank('Chidi Okonkwo');
    expect(await screen.findByText('Name matches')).toBeTruthy();
    await fireEvent.press(continueButton());
    expect(useSendDraft.getState().recipient).toMatchObject({
      kind: 'bank',
      name: 'Chidi Okonkwo',
      bankCode: '058',
      nameMatch: { result: 'match' },
    });
  });

  it('blocks a mismatched name until the customer says they checked', async () => {
    await payAtGtbank('Blessing Johnson');
    expect(await screen.findByText('Name does not match')).toBeTruthy();
    expect(continueButton()).toBeDisabled();

    await fireEvent.press(screen.getByRole('checkbox', { name: /I have checked/ }));
    await waitFor(() => expect(continueButton()).toBeEnabled());
  });
});
