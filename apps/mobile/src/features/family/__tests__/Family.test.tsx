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
  controlsSummary,
  DEFAULT_CONTROLS,
  dependantAgeProblem,
  formatSetupCode,
} from '../family';
import { AddDependantScreen } from '../screens/AddDependantScreen';
import { FamilyScreen } from '../screens/FamilyScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
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
