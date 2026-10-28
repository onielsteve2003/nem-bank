import { money } from '@nem/shared';
import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ModalSheetHost, ToastProvider } from '@/components';
import { RepositoryProvider, type Repositories } from '@/data';
import { createMockRepositories } from '@/data/mock';
import { DEMO_PIN } from '@/data/mock/domains/auth';
import { createMemoryStore } from '@/data/mock/persistence/types';
import { QueryProvider } from '@/lib/query';
import { ThemeProvider } from '@/theme';

import { DevicesScreen } from '../screens/DevicesScreen';
import { DuressScreen } from '../screens/DuressScreen';
import { LimitsScreen } from '../screens/LimitsScreen';
import { PanicScreen } from '../screens/PanicScreen';
import { SecurityScreen } from '../screens/SecurityScreen';
import {
  checkupAction,
  deviceStatus,
  limitChange,
  limitsProblem,
  panicSummary,
  scoreBand,
  splitCheckup,
} from '../security';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));

configure({ defaultIncludeHiddenElements: true });

const bank = () =>
  createMockRepositories({
    store: createMemoryStore(),
    clock: () => new Date(Date.now()),
    simulation: { latency: 'off' },
  });

const wrap = (repos: Repositories, ui: React.ReactElement = <SecurityScreen />) => (
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

const item = (id: string, points: number, done: boolean) =>
  ({ id, title: id, description: '', points, done }) as never;

describe('security checkup rules', () => {
  it('names the score band in words', () => {
    expect(scoreBand(100).label).toBe('Strong');
    expect(scoreBand(80).label).toBe('Strong');
    expect(scoreBand(79).label).toBe('Good, could be better');
    expect(scoreBand(49).label).toBe('Needs attention');
  });

  it('puts the biggest gains first and keeps done items apart', () => {
    const { todo, done } = splitCheckup([
      item('alerts_on', 10, false),
      item('pin_set', 20, true),
      item('kyc_tier_2', 20, false),
    ]);
    expect(todo.map((i) => (i as { id: string }).id)).toEqual(['kyc_tier_2', 'alerts_on']);
    expect(done).toHaveLength(1);
  });

  it('sends each to-do to the screen that fixes it', () => {
    expect(checkupAction('kyc_tier_2')).toEqual({ kind: 'route', href: '/kyc' });
    expect(checkupAction('security_question_set')).toEqual({ kind: 'question' });
    expect(checkupAction('duress_pin_set')).toEqual({ kind: 'route', href: '/security/duress' });
    expect(checkupAction('alerts_on')).toBeNull();
  });
});

describe('security center', () => {
  const fixFor = (title: string) => {
    const button = screen
      .getAllByRole('button', { name: 'Fix this' })
      .find((b) => b.props.accessibilityHint === title);
    if (!button) throw new Error(`No fix button for ${title}`);
    return button;
  };

  it('shows the score with what to do next and what is done', async () => {
    const repos = bank();
    const { score } = await repos.security.getCheckup();
    await render(wrap(repos));
    expect(
      await screen.findByLabelText(new RegExp(`^Security score ${score} out of 100\.`)),
    ).toBeTruthy();
    expect(screen.getByText('Do next')).toBeTruthy();
    expect(screen.getByText('Set a duress PIN')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Panic button/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Devices and sessions/ })).toBeTruthy();
  });

  it('adds a security question and the score goes up', async () => {
    const repos = bank();
    const before = (await repos.security.getCheckup()).score;
    await render(wrap(repos));
    await screen.findByText('Add a security question');
    await fireEvent.press(fixFor('Add a security question'));
    await fireEvent.press(
      await screen.findByRole('button', { name: 'In which town did your parents meet?' }),
    );
    expect(screen.getByRole('button', { name: 'Save security question' })).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Answer'), 'Enugu');
    await fireEvent.press(screen.getByRole('button', { name: 'Save security question' }));
    await waitFor(() =>
      expect(
        screen.getByLabelText(new RegExp(`^Security score ${before + 10} out of 100\.`)),
      ).toBeTruthy(),
    );
    expect(
      (await repos.security.getCheckup()).items.find((i) => i.id === 'security_question_set')?.done,
    ).toBe(true);
  });

  it('offers a fix for the duress PIN', async () => {
    await render(wrap(bank()));
    await screen.findByText('Set a duress PIN');
    expect(fixFor('Set a duress PIN')).toBeTruthy();
  });
});

describe('devices and sessions', () => {
  it('describes a device’s trust in words', () => {
    const base = {
      trusted: true,
      hardware_backed: true,
      cool_off_until: null,
    } as unknown as Parameters<typeof deviceStatus>[0];
    expect(deviceStatus(base).label).toBe('Trusted, key in secure hardware');
    expect(deviceStatus({ ...base, hardware_backed: false }).label).toBe('Trusted');
    expect(deviceStatus({ ...base, trusted: false }).label).toBe('Not trusted yet');
    expect(
      deviceStatus({ ...base, cool_off_until: '2026-01-02T00:00:00Z' }, new Date('2026-01-01'))
        .label,
    ).toBe('New device, lower limits for now');
  });

  it('removes another device, which ends its sign-ins and lifts the score', async () => {
    const repos = bank();
    const before = (await repos.security.getCheckup()).score;
    await render(wrap(repos, <DevicesScreen />));
    expect(await screen.findByText('This device')).toBeTruthy();
    expect(screen.getAllByText('Chrome on Windows')).toHaveLength(2);
    const remove = screen
      .getAllByRole('button', { name: 'Remove' })
      .find((b) => b.props.accessibilityHint === 'Chrome on Windows');
    await fireEvent.press(remove!);
    await fireEvent.press(await screen.findByRole('button', { name: 'Remove device' }));
    await waitFor(() => expect(screen.queryAllByText('Chrome on Windows')).toHaveLength(0));
    expect((await repos.devices.list()).data).toHaveLength(1);
    expect((await repos.security.listSessions()).data.every((s) => s.current)).toBe(true);
    expect((await repos.security.getCheckup()).score).toBe(before + 10);
  });

  it('signs out another session but keeps the device', async () => {
    const repos = bank();
    await render(wrap(repos, <DevicesScreen />));
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign out' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Sign out now' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull());
    expect((await repos.security.listSessions()).data).toHaveLength(1);
    expect((await repos.devices.list()).data).toHaveLength(2);
    expect(screen.getByText('You’re here')).toBeTruthy();
  });
});

const naira = (n: number) => money(BigInt(n) * 100n, 'NGN');

describe('self-set limits', () => {
  const cap = naira(200_000);

  it('treats removing a limit as raising it', () => {
    expect(limitChange(null, naira(5_000))).toBe('lower');
    expect(limitChange(naira(5_000), null)).toBe('raise');
    expect(limitChange(naira(5_000), naira(6_000))).toBe('raise');
    expect(limitChange(naira(5_000), naira(4_000))).toBe('lower');
    expect(limitChange(null, null)).toBe('same');
  });

  it('keeps limits under the KYC cap and single under daily', () => {
    expect(limitsProblem(naira(200_001), null, cap)).toMatch(/daily limit can't be above/);
    expect(limitsProblem(null, naira(300_000), cap)).toMatch(/single transfer can't be above/);
    expect(limitsProblem(naira(10_000), naira(20_000), cap)).toBe(
      "A single transfer can't be above your daily limit",
    );
    expect(limitsProblem(naira(20_000), naira(10_000), cap)).toBeUndefined();
  });

  it('bank: raising needs a step-up and still waits 24 hours', async () => {
    const repos = bank();
    const body = (n: number | null) => ({
      daily_limit: n === null ? null : { amount_minor: String(n * 100), currency: 'NGN' as const },
      single_limit: null,
    });
    await repos.security.setLimits({ body: body(20_000) });
    await expect(repos.security.setLimits({ body: body(50_000) })).rejects.toMatchObject({
      problem: { code: 'step_up_required' },
    });
    const challenge = await repos.auth.startStepUp({
      body: { purpose: 'limit_increase', resource_id: 'self_limits' },
    });
    const { step_up_token } = await repos.auth.verifyStepUp({
      path: { step_up_id: challenge.step_up_id },
      body: { pin: DEMO_PIN },
    });
    const raised = await repos.security.setLimits({
      body: body(50_000),
      stepUpToken: step_up_token,
    });
    expect(raised.daily_limit?.amount_minor).toBe('2000000');
    expect(raised.pending_increase?.daily_limit?.amount_minor).toBe('5000000');
    const lowered = await repos.security.setLimits({ body: body(10_000) });
    expect(lowered.pending_increase).toBeNull();
  });

  it('lowers a limit at once from the screen and the checkup counts it', async () => {
    const repos = bank();
    await render(wrap(repos, <LimitsScreen />));
    await fireEvent.press(await screen.findByLabelText('Daily limit, No limit. Change'));
    await fireEvent.press(await screen.findByRole('togglebutton', { name: '₦20,000' }));
    expect(screen.getByText('Lowering a limit applies straight away.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByLabelText('Daily limit, ₦20,000. Change')).toBeTruthy();
    expect(
      (await repos.security.getCheckup()).items.find((i) => i.id === 'self_limit_set')?.done,
    ).toBe(true);
  });

  it('asks for the PIN before raising and shows the waiting increase', async () => {
    const repos = bank();
    await repos.security.setLimits({
      body: { daily_limit: { amount_minor: '2000000', currency: 'NGN' }, single_limit: null },
    });
    await render(wrap(repos, <LimitsScreen />));
    await fireEvent.press(await screen.findByLabelText('Daily limit, ₦20,000. Change'));
    await fireEvent.press(await screen.findByRole('togglebutton', { name: '₦50,000' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Raise in 24 hours' }));
    expect(await screen.findByText('Raise your limit. It starts in 24 hours.')).toBeTruthy();
    expect((await repos.security.getLimits()).pending_increase).toBeNull();
  });
});

describe('panic button', () => {
  it('says what panic mode did', () => {
    const state = { active: true, activated_at: null, cards_frozen: 1, outgoing_blocked: true };
    expect(panicSummary(state)).toBe('1 card frozen and no money can leave your account.');
    expect(panicSummary({ ...state, cards_frozen: 0 })).toBe(
      'No cards needed freezing and no money can leave your account.',
    );
    expect(panicSummary({ ...state, active: false })).toBe('Panic mode is off.');
  });

  it('freezes every card and blocks sending after one confirmed tap', async () => {
    const repos = bank();
    const active = (await repos.cards.list()).data.filter((c) => c.status === 'active').length;
    await render(wrap(repos, <PanicScreen />));
    await fireEvent.press(await screen.findByRole('button', { name: 'Freeze everything' }));
    const buttons = await screen.findAllByRole('button', { name: 'Freeze everything' });
    await fireEvent.press(buttons.at(-1)!);
    expect(await screen.findByText('Panic mode is on')).toBeTruthy();
    const state = await repos.security.getPanic();
    expect(state).toMatchObject({ active: true, cards_frozen: active, outgoing_blocked: true });
    expect((await repos.cards.list()).data.some((c) => c.status === 'active')).toBe(false);
    expect(screen.getByRole('button', { name: 'Turn off panic mode' })).toBeTruthy();
  });

  it('needs a step-up to turn off, then unfreezes the cards it froze', async () => {
    const repos = bank();
    await repos.security.activatePanic();
    await expect(repos.security.releasePanic({ stepUpToken: 'not-a-token' })).rejects.toMatchObject(
      {
        problem: { code: 'step_up_required' },
      },
    );
    const challenge = await repos.auth.startStepUp({
      body: { purpose: 'unfreeze', resource_id: 'panic' },
    });
    const { step_up_token } = await repos.auth.verifyStepUp({
      path: { step_up_id: challenge.step_up_id },
      body: { pin: DEMO_PIN },
    });
    expect((await repos.security.releasePanic({ stepUpToken: step_up_token })).active).toBe(false);
    expect((await repos.cards.list()).data.some((c) => c.status === 'active')).toBe(true);
  });

  it('shows panic mode on the security center', async () => {
    const repos = bank();
    await repos.security.activatePanic();
    await render(wrap(repos));
    expect(await screen.findByText('Panic mode is on')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy();
  });
});

describe('duress PIN', () => {
  const DURESS = '7319';
  const stepUpToken = async (repos: Repositories, pin = DEMO_PIN) => {
    const challenge = await repos.auth.startStepUp({
      body: { purpose: 'pin_reset', resource_id: 'duress_pin' },
    });
    return (
      await repos.auth.verifyStepUp({ path: { step_up_id: challenge.step_up_id }, body: { pin } })
    ).step_up_token;
  };
  const ngn = async (repos: Repositories) =>
    (await repos.accounts.list()).data.find((a) => a.currency === 'NGN')!;

  it('bank: the duress PIN unlocks into a decoy, payments move nothing, the real PIN ends it', async () => {
    const repos = bank();
    await repos.security.setDuressPin({
      body: { pin: DURESS },
      stepUpToken: await stepUpToken(repos),
    });
    const real = await ngn(repos);
    const beneficiary = (await repos.beneficiaries.list()).data.find((b) => b.kind === 'bank')!;

    expect((await repos.users.verifyPin({ body: { pin: DURESS } })).valid).toBe(true);
    const decoy = await ngn(repos);
    expect(BigInt(decoy.available_balance.amount_minor)).toBeLessThanOrEqual(385_000n);
    const activity = (await repos.transactions.list()).data;
    expect(activity.every((t) => BigInt(t.amount.amount_minor) <= 1_000_000n)).toBe(true);
    // The checkup does not give the duress PIN away, and removing it does nothing.
    const checkup = await repos.security.getCheckup();
    expect(checkup.items.find((i) => i.id === 'duress_pin_set')?.done).toBe(false);
    await repos.security.removeDuressPin({ stepUpToken: await stepUpToken(repos, DURESS) });

    const sent = await repos.transfers.create({
      body: {
        source_account_id: real.id,
        destination: { kind: 'beneficiary', beneficiary_id: beneficiary.id },
        amount: { amount_minor: '200000', currency: 'NGN' },
        save_beneficiary: false,
      },
      idempotencyKey: 'duress-1',
    });
    expect(sent.status).toBe('processing');
    await expect(
      repos.transfers.create({
        body: {
          source_account_id: real.id,
          destination: { kind: 'beneficiary', beneficiary_id: beneficiary.id },
          amount: { amount_minor: '1000000', currency: 'NGN' },
          save_beneficiary: false,
        },
        idempotencyKey: 'duress-2',
      }),
    ).rejects.toMatchObject({ problem: { code: 'insufficient_funds' } });

    expect((await repos.users.verifyPin({ body: { pin: DEMO_PIN } })).valid).toBe(true);
    expect((await ngn(repos)).available_balance).toEqual(real.available_balance);
    const stopped = await repos.transfers.get({ path: { transfer_id: sent.id } });
    expect(stopped.status).toBe('failed');
    expect(stopped.timeline.at(-1)?.label).toBe('Stopped by Nem');
    // Still set: the removal in duress was ignored.
    const after = await repos.security.getCheckup();
    expect(after.items.find((i) => i.id === 'duress_pin_set')?.done).toBe(true);
  });

  it('bank: refuses a duress PIN that matches the real PIN', async () => {
    const repos = bank();
    await expect(
      repos.security.setDuressPin({
        body: { pin: DEMO_PIN },
        stepUpToken: await stepUpToken(repos),
      }),
    ).rejects.toMatchObject({ problem: { code: 'validation_failed' } });
  });

  it('sets a duress PIN: entered twice, then approved with the real PIN', async () => {
    const repos = bank();
    await render(wrap(repos, <DuressScreen />));
    await fireEvent.press(await screen.findByRole('button', { name: 'Set a duress PIN' }));
    const type = async (pin: string) => {
      for (const d of pin) await fireEvent.press(screen.getByRole('button', { name: d }));
    };
    await type('1111');
    expect(await screen.findByText(/Too easy to guess/)).toBeTruthy();
    await type(DURESS);
    await screen.findByText('Enter it again');
    await type(DURESS);
    await screen.findByText("Confirm it's you");
    await type(DEMO_PIN);
    expect(await screen.findByText('Your duress PIN is on')).toBeTruthy();
    const checkup = await repos.security.getCheckup();
    expect(checkup.items.find((i) => i.id === 'duress_pin_set')?.done).toBe(true);
  });
});
