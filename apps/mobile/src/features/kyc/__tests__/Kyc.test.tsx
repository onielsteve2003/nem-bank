import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { displayDate, identityProblem, kycStatusText, nextTier, upgradeHref } from '../kyc';
import { IdentityScreen } from '../screens/IdentityScreen';
import { KycScreen } from '../screens/KycScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));

configure({ defaultIncludeHiddenElements: true });

/** A bank whose customer is on `tier` (the demo persona starts fully verified). */
const bank = async (tier: 1 | 2 | 3 = 1) => {
  const repos = createMockRepositories({
    store: createMemoryStore(),
    clock: () => new Date(Date.now()),
    simulation: { latency: 'off' },
  });
  await repos.demo.setKycTier({ body: { tier } });
  return repos;
};

const wrap = (repos: Repositories, ui: React.ReactElement = <KycScreen />) => (
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

const overview = (tier: 1 | 2 | 3, status = 'not_started') =>
  ({ tier, status, tiers: [], latest_submission: null, demo_limits: true }) as never;

describe('KYC rules', () => {
  it('names the next tier, none at the top', () => {
    expect(nextTier(1)).toBe(2);
    expect(nextTier(2)).toBe(3);
    expect(nextTier(3)).toBeNull();
  });

  it('describes where you stand', () => {
    expect(kycStatusText(overview(2, 'pending_review'))).toMatch(/being reviewed/);
    expect(kycStatusText(overview(3, 'approved'))).toMatch(/fully verified/);
    expect(kycStatusText(overview(1))).toMatch(/raise your limits/);
  });

  it('starts Tier 2 at the BVN or NIN screen', () => {
    expect(upgradeHref(overview(1))).toBe('/kyc/identity');
  });

  it('says why a BVN or NIN check failed', () => {
    const result = (extra: object) =>
      ({ type: 'nin', verified: false, sandbox: true, tier: 1, ...extra }) as never;
    expect(identityProblem(result({}))).toMatch(/couldn’t find that NIN/);
    expect(identityProblem(result({ date_of_birth_match: false }))).toMatch(
      /date of birth doesn’t match your NIN/,
    );
    expect(identityProblem(result({ verified: true }))).toBeUndefined();
  });

  it('shows dates the way people type them', () => {
    expect(displayDate('2000-03-14')).toBe('14/03/2000');
  });

  it('offers no upgrade at the top or while a reviewer has your documents', () => {
    expect(upgradeHref(overview(3, 'approved'))).toBeNull();
    expect(upgradeHref(overview(2, 'pending_review'))).toBeNull();
  });
});

describe('KycScreen', () => {
  it('shows your tier, its limits and every tier', async () => {
    await render(wrap(await bank()));
    expect((await screen.findAllByText('Tier 1')).length).toBe(2);
    expect(screen.getByLabelText('You can send: ₦50,000 a day')).toBeOnTheScreen();
    expect(screen.getByLabelText('You can hold: ₦300,000')).toBeOnTheScreen();
    expect(screen.getByText('Your tier')).toBeOnTheScreen();
    expect(screen.getByLabelText('Daily limit: ₦5,000,000')).toBeOnTheScreen();
    expect(screen.getByLabelText('Most you can hold: No limit')).toBeOnTheScreen();
    expect(screen.getByText(/Demo limits/)).toBeOnTheScreen();
  });

  it('explains the next tier: what it needs and what it unlocks', async () => {
    await render(wrap(await bank()));
    expect(await screen.findByText(/You’ll need: BVN or NIN/)).toBeOnTheScreen();
    expect(screen.getByText(/dollar, pound and euro wallets/)).toBeOnTheScreen();
  });

  it('shows nothing to upgrade at the top', async () => {
    await render(wrap(await bank(3)));
    expect(await screen.findByText(/fully verified/)).toBeOnTheScreen();
    expect(screen.queryByText(/Upgrade to Tier/)).toBeNull();
  });

  it('waits while a reviewer has your documents', async () => {
    const repos = await bank(2);
    const docs = await Promise.all(
      (['id_front', 'selfie'] as const).map((kind) =>
        repos.kyc.uploadDocument({ body: { kind, file: 'x'.repeat(4_000) } }),
      ),
    );
    await repos.kyc.submit({
      body: {
        target_tier: 3,
        id_type: 'national_id',
        id_number: '12345678901',
        document_ids: docs.map((d) => d.id),
        address: { line1: '12 Admiralty Way', city: 'Lekki', state: 'Lagos', country: 'NG' },
      },
    });
    await render(wrap(repos));
    expect(await screen.findByText(/being reviewed/)).toBeOnTheScreen();
    expect(screen.getByText('We’re checking your documents.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /Upgrade to Tier 3/ })).toBeNull();
  });
});

describe('IdentityScreen', () => {
  const fill = async (number: string, dob: string) => {
    await fireEvent.changeText(screen.getByLabelText('Bank Verification Number'), number);
    await fireEvent.changeText(screen.getByLabelText('Date of birth'), dob);
  };

  it('verifies a sandbox BVN with the right date of birth and lands on Tier 2', async () => {
    const repos = await bank();
    await render(wrap(repos, <IdentityScreen />));
    expect(await screen.findByText(/date of birth 14\/03\/2000/)).toBeOnTheScreen();
    const button = screen.getByRole('button', { name: 'Verify BVN' });
    expect(button).toBeDisabled();
    await fill('22212345678', '14032000');
    await fireEvent.press(button);
    expect(await screen.findByText('You’re on Tier 2')).toBeOnTheScreen();
    expect((await repos.kyc.getOverview()).tier).toBe(2);
  });

  it('refuses a date of birth that is not on the record', async () => {
    const repos = await bank();
    await render(wrap(repos, <IdentityScreen />));
    await fill('22212345678', '01/01/1999');
    await fireEvent.press(screen.getByRole('button', { name: 'Verify BVN' }));
    expect(await screen.findByText(/doesn’t match your BVN record/)).toBeOnTheScreen();
    expect((await repos.kyc.getOverview()).tier).toBe(1);
  });

  it('says when a number is not found', async () => {
    await render(wrap(await bank(), <IdentityScreen />));
    await fill('00000000000', '14/03/2000');
    await fireEvent.press(screen.getByRole('button', { name: 'Verify BVN' }));
    expect(await screen.findByText(/couldn’t find that BVN/)).toBeOnTheScreen();
  });

  it('switches to NIN and explains real checks need a paid provider', async () => {
    await render(wrap(await bank(), <IdentityScreen />));
    await fireEvent.press(await screen.findByRole('togglebutton', { name: 'NIN' }));
    expect(screen.getByLabelText('National Identification Number')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Real verification' }));
    expect(await screen.findByText(/Real BVN and NIN checks requires/)).toBeOnTheScreen();
  });
});
