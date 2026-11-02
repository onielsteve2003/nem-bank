import { QueryClient } from '@tanstack/react-query';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories, DEMO_PIN } from '@/data/mock';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import {
  ageOn,
  allowanceSummary,
  goalPercent,
  spendLeftToday,
  controlsSummary,
  DEFAULT_CONTROLS,
  dependantAgeProblem,
  formatSetupCode,
} from '../family';
import { AddDependantScreen } from '../screens/AddDependantScreen';
import { ApprovalsScreen } from '../screens/ApprovalsScreen';
import { DependantScreen } from '../screens/DependantScreen';
import { KidHomeScreen } from '../screens/KidHomeScreen';
import { FamilyScreen } from '../screens/FamilyScreen';

const mockPush = jest.fn();
const mockParams: { id?: string } = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => mockParams,
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

/** Moves the mock bank's clock forward, so allowances and approvals come due. */
let skew = 0;
const later = (ms: number) => (skew += ms);
beforeEach(() => (skew = 0));

const bank = () =>
  createMockRepositories({
    store: createMemoryStore(),
    clock: () => new Date(Date.now() + skew),
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

/** A date of birth `years` ago today, as DD/MM/YYYY and ISO. */
const born = (years: number) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years, d.getUTCMonth(), 1);
  const iso = d.toISOString().slice(0, 10);
  return { iso, typed: iso.split('-').reverse().join('/') };
};

const stepUpToken = async (repos: Repositories) => {
  const { step_up_id } = await repos.auth.startStepUp({
    body: { purpose: 'new_beneficiary', resource_id: 'family' },
  });
  return (await repos.auth.verifyStepUp({ path: { step_up_id }, body: { pin: DEMO_PIN } }))
    .step_up_token;
};

const addChild = async (repos: Repositories, nemtag = 'ada_kid') =>
  repos.family.createDependant({
    body: {
      first_name: 'Ada',
      last_name: 'Bello',
      date_of_birth: born(10).iso,
      nemtag,
      controls: DEFAULT_CONTROLS,
    },
    stepUpToken: await stepUpToken(repos),
  });

describe('family rules', () => {
  const now = new Date('2026-10-28T10:00:00Z');

  it('counts whole years, birthday included', () => {
    expect(ageOn('2016-10-28', now)).toBe(10);
    expect(ageOn('2016-10-29', now)).toBe(9);
  });

  it('takes children from 6 to 17', () => {
    expect(dependantAgeProblem('2020-11-01', now)).toBe('Children need to be at least 6');
    expect(dependantAgeProblem('2008-10-28', now)).toBe(
      'At 18 they can open their own Nem account',
    );
    expect(dependantAgeProblem('2027-01-01', now)).toBe('That date is in the future');
    expect(dependantAgeProblem('2014-05-01', now)).toBeUndefined();
  });

  it('reads controls the way a parent would', () => {
    expect(controlsSummary(DEFAULT_CONTROLS)).toEqual([
      'Spends up to ₦5,000 a day',
      'Asks you before sending more than ₦2,000',
      'Can pay Nem users only',
    ]);
    expect(formatSetupCode('12345678')).toBe('1234 5678');
  });

  it('says an allowance the way a parent would', () => {
    const amount = { amount_minor: '200000', currency: 'NGN' as const };
    expect(allowanceSummary({ amount, frequency: 'weekly', day: 5, source_account_id: 'a' })).toBe(
      '₦2,000 every Friday',
    );
    expect(
      allowanceSummary({ amount, frequency: 'monthly', day: 21, source_account_id: 'a' }),
    ).toBe('₦2,000 on the 21st of each month');
  });
});

describe('mock family', () => {
  it('needs a step-up and gives an 8-digit setup code', async () => {
    const repos = bank();
    await expect(
      repos.family.createDependant({
        body: {
          first_name: 'Ada',
          last_name: 'Bello',
          date_of_birth: born(10).iso,
          nemtag: 'ada_kid',
          controls: DEFAULT_CONTROLS,
        },
        stepUpToken: 'not-a-token',
      }),
    ).rejects.toBeTruthy();
    const created = await addChild(repos);
    expect(created.setup_code).toMatch(/^\d{8}$/);
    expect(created.dependant).toMatchObject({ kid_mode: true, profile: { nemtag: 'ada_kid' } });
  });

  it('keeps a child’s @nemtag unique', async () => {
    const repos = bank();
    await addChild(repos);
    expect((await repos.users.checkNemtag({ path: { nemtag: 'ada_kid' } })).available).toBe(false);
    await expect(addChild(repos)).rejects.toMatchObject({ problem: { code: 'nemtag_taken' } });
  });
});

describe('FamilyScreen', () => {
  it('invites you to add a child when there are none', async () => {
    await render(wrap(bank(), <FamilyScreen />));
    expect(await screen.findByText('Add your child')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Add a child' }));
    expect(mockPush).toHaveBeenCalledWith('/family/add');
  });

  it('lists children with their balance and limits', async () => {
    const repos = bank();
    await addChild(repos);
    await render(wrap(repos, <FamilyScreen />));
    expect(await screen.findByText('Ada Bello')).toBeOnTheScreen();
    expect(screen.getByText(/@ada_kid · \d+ years old/)).toBeOnTheScreen();
    expect(screen.getByText('Kid mode')).toBeOnTheScreen();
    expect(screen.getByText('Spends up to ₦5,000 a day')).toBeOnTheScreen();
  });
});

describe('AddDependantScreen', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const next = () => fireEvent.press(screen.getByRole('button', { name: 'Continue' }));

  it('adds a child after your PIN and shows their setup code once', async () => {
    const repos = bank();
    await render(wrap(repos, <AddDependantScreen />));
    await fireEvent.changeText(await screen.findByLabelText('First name'), 'Ada');
    await fireEvent.changeText(screen.getByLabelText('Last name'), 'Bello');
    await fireEvent.changeText(screen.getByLabelText('Date of birth'), born(3).typed);
    expect(screen.getByText('Children need to be at least 6')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Date of birth'), born(10).typed);
    await next();

    await fireEvent.changeText(await screen.findByLabelText('Their @nemtag'), 'ada_kid');
    await act(() => jest.advanceTimersByTimeAsync(500));
    expect(await screen.findByText('@ada_kid is yours if you want it')).toBeOnTheScreen();
    await next();

    // The daily limit comes first; the approval amounts repeat some values.
    const [daily] = await screen.findAllByRole('togglebutton', { name: '₦10,000' });
    await fireEvent.press(daily!);
    await next();
    expect(await screen.findByText('Spends up to ₦10,000 a day')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Add Ada' }));
    expect(await screen.findByText('Add Ada Bello to your family')).toBeOnTheScreen();
    for (const digit of DEMO_PIN)
      await fireEvent.press(screen.getByRole('button', { name: digit }));

    expect(await screen.findByText('Ada is on Nem')).toBeOnTheScreen();
    expect(screen.getByText(/^\d{4} \d{4}$/)).toBeOnTheScreen();
    await waitFor(async () => expect((await repos.family.listDependants()).data).toHaveLength(1));
    const [child] = (await repos.family.listDependants()).data;
    expect(child!.controls.daily_spend_limit.amount_minor).toBe('1000000');
  });
});

describe('DependantScreen', () => {
  it('changes limits, pauses spending and sets an allowance', async () => {
    const repos = bank();
    const { dependant } = await addChild(repos);
    mockParams.id = dependant.id;
    await render(wrap(repos, <DependantScreen />));
    expect(await screen.findByText('Nothing yet')).toBeOnTheScreen();

    const [daily] = screen.getAllByRole('togglebutton', { name: '₦20,000' });
    await fireEvent.press(daily!);
    await fireEvent.press(screen.getByRole('switch', { name: 'Pause spending' }));
    await waitFor(async () =>
      expect(
        (await repos.family.getDependant({ path: { dependant_id: dependant.id } })).controls,
      ).toMatchObject({ paused: true, daily_spend_limit: { amount_minor: '2000000' } }),
    );

    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Monthly' }));
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Day 14' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Set allowance' }));
    expect(await screen.findByText('₦2,000 on the 14th of each month')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Stop allowance' }));
    expect(await screen.findByRole('button', { name: 'Set allowance' })).toBeOnTheScreen();
  });
});

describe('ApprovalsScreen', () => {
  it('approves a child’s transfer with your PIN', async () => {
    const repos = bank();
    const { dependant } = await addChild(repos);
    const [own] = (await repos.accounts.list()).data.filter((a) => a.currency === 'NGN');
    await repos.family.setAllowance({
      path: { dependant_id: dependant.id },
      body: {
        amount: { amount_minor: '1000000', currency: 'NGN' },
        frequency: 'weekly',
        day: 1,
        source_account_id: own!.id,
      },
    });
    later(8 * 24 * 3_600_000);
    await render(wrap(repos, <ApprovalsScreen />));
    expect(
      await screen.findByText(
        'Ada Bello → ' + (await repos.family.listApprovals()).data[0]!.recipient.name,
      ),
    ).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Approve' }));
    for (const digit of DEMO_PIN)
      await fireEvent.press(screen.getByRole('button', { name: digit }));
    expect(await screen.findByText('Approved')).toBeOnTheScreen();
    expect(screen.getByText('Nothing to approve')).toBeOnTheScreen();
  });

  it('shows an empty queue', async () => {
    await render(wrap(bank(), <ApprovalsScreen />));
    expect(await screen.findByText('Nothing to approve')).toBeOnTheScreen();
  });
});

describe('kid mode', () => {
  it('works out what is left to spend today and goal progress', () => {
    const now = new Date('2026-11-02T12:00:00Z');
    const txn = (direction: 'debit' | 'credit', minor: string, at: string) =>
      ({ direction, amount: { amount_minor: minor, currency: 'NGN' }, created_at: at }) as never;
    const left = spendLeftToday(
      DEFAULT_CONTROLS,
      [
        txn('debit', '150000', '2026-11-02T09:00:00Z'),
        txn('credit', '900000', '2026-11-02T08:00:00Z'),
        txn('debit', '400000', '2026-11-01T09:00:00Z'),
      ],
      now,
    );
    expect(left.amount).toBe(350000n);
    expect(
      spendLeftToday(DEFAULT_CONTROLS, [txn('debit', '900000', now.toISOString())], now).amount,
    ).toBe(0n);
    expect(goalPercent(250000n, 1000000n)).toBe(25);
    expect(goalPercent(2000000n, 1000000n)).toBe(100);
  });

  it('shows the child their balance and lets them add a goal', async () => {
    const repos = bank();
    const { dependant } = await addChild(repos);
    mockParams.id = dependant.id;
    await render(wrap(repos, <KidHomeScreen />));
    expect(await screen.findByText('Hi Ada 👋')).toBeOnTheScreen();
    expect(screen.getByText('₦5,000 left to spend today')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Add a goal' }));
    await fireEvent.changeText(screen.getByLabelText('What are you saving for?'), 'New bike');
    await fireEvent.press(screen.getByRole('button', { name: 'Save goal' }));
    expect(await screen.findByText('New bike')).toBeOnTheScreen();
    expect(screen.getByText('0% of ₦5,000')).toBeOnTheScreen();
  });
});
