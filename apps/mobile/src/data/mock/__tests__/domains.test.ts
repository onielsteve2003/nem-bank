import { isApiError } from '../../errors';
import { DOMAINS, REPOSITORY_METHODS, type Repositories } from '../../repositories';
import { SNAPSHOT_KEY } from '../bank';
import { createMockRepositories, DEMO_OTP } from '../index';
import { deserialize } from '../persistence/serialize';
import { createMemoryStore, type SnapshotStore } from '../persistence/types';
import type { MockBankState } from '../bank';
import { Ledger } from '../ledger';

const START = new Date('2026-10-17T12:00:00.000Z');
const naira = (major: number) => ({ amount_minor: String(major * 100), currency: 'NGN' as const });

function setup(store: SnapshotStore = createMemoryStore()) {
  let now = START;
  const repos = createMockRepositories({ store, clock: () => now, simulation: { latency: 'off' } });
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  return { repos, store, advance };
}

async function ngnAccount(repos: Repositories) {
  const { data } = await repos.accounts.list();
  return data.find((a) => a.currency === 'NGN')!;
}

const available = async (repos: Repositories) =>
  BigInt((await ngnAccount(repos)).available_balance.amount_minor);

async function stepUpToken(
  repos: Repositories,
  purpose: Parameters<Repositories['auth']['startStepUp']>[0]['body']['purpose'],
) {
  const challenge = await repos.auth.startStepUp({ body: { purpose } });
  const token = await repos.auth.verifyStepUp({
    path: { step_up_id: challenge.step_up_id },
    body: { otp_code: DEMO_OTP },
  });
  return token.step_up_token;
}

async function trialBalance(store: SnapshotStore) {
  const state = deserialize<MockBankState>((await store.read(SNAPSHOT_KEY))!);
  return new Ledger(state.ledger, { now: () => START, newId: () => 'x' }).trialBalance();
}

describe('mock repositories', () => {
  it('implements every repository method', () => {
    const { repos } = setup();
    for (const domain of DOMAINS) {
      for (const method of Object.keys(REPOSITORY_METHODS[domain])) {
        expect(typeof (repos[domain] as Record<string, unknown>)[method]).toBe('function');
      }
    }
  });

  it('checks sign-up details with the shared rules and refuses an email already in use', async () => {
    const { repos } = setup();
    const body = {
      first_name: 'Ada',
      last_name: 'Obi',
      email: 'ada@example.com',
      phone: '+2348031234567',
      date_of_birth: '1994-03-05',
      consent: {
        terms_version: '2026-10',
        privacy_version: '2026-10',
        accepted_at: START.toISOString(),
      },
    };
    const started = await repos.auth.startSignup({ body });
    expect(started.otp.destination_masked).toBe('a*a@example.com');

    const minor = await repos.auth
      .startSignup({ body: { ...body, date_of_birth: '2015-01-01' } })
      .catch((e: unknown) => e);
    expect(isApiError(minor, 'validation_failed') && minor.problem.errors?.[0]?.field).toBe(
      '/date_of_birth',
    );

    const me = await repos.users.getMe();
    const taken = await repos.auth
      .startSignup({ body: { ...body, email: me.email.toUpperCase() } })
      .catch((e: unknown) => e);
    expect(isApiError(taken, 'email_taken') && taken.status).toBe(409);
  });

  it('finishes sign-up with a strong password and PIN, refusing birthday PINs', async () => {
    const { repos } = setup();
    const started = await repos.auth.startSignup({
      body: {
        first_name: 'Ada',
        last_name: 'Obi',
        email: 'ada@example.com',
        phone: '+2348031234567',
        date_of_birth: '1994-03-05',
        consent: {
          terms_version: '2026-10',
          privacy_version: '2026-10',
          accepted_at: START.toISOString(),
        },
      },
    });
    const { verification_token } = await repos.auth.verifyOtp({
      body: { challenge_id: started.otp.challenge_id, code: '123456' },
    });
    const device = { name: "Ada's iPhone", platform: 'ios' as const, public_key: 'A'.repeat(43) };
    const finish = (password: string, pin: string) =>
      repos.auth
        .completeSignup({
          body: { signup_id: started.signup_id, verification_token, password, pin, device },
        })
        .catch((e: unknown) => e);

    expect(isApiError(await finish('Password2026!', '2580'), 'weak_password')).toBe(true);
    expect(isApiError(await finish('Kitchen-Mango-River-7', '0503'), 'weak_pin')).toBe(true);

    const session = await finish('Kitchen-Mango-River-7', '2580');
    expect(session).toMatchObject({ user: { first_name: 'Ada', has_pin: true } });
    expect(await repos.users.verifyPin({ body: { pin: '2580' } })).toMatchObject({ valid: true });
  });

  it('applies the email code rules: attempts, expiry and the resend cooldown', async () => {
    const { repos, advance } = setup();
    const ask = () => repos.auth.forgotPassword({ body: { email: 'tolu.demo@example.com' } });
    const check = (challenge_id: string, code: string) =>
      repos.auth.verifyOtp({ body: { challenge_id, code } });

    const otp = await ask();
    expect(otp.attempts_remaining).toBe(5);
    for (let left = 4; left >= 0; left--) {
      await expect(check(otp.challenge_id, '000000')).rejects.toMatchObject({
        problem: { code: 'invalid_otp', detail: `${left} attempt${left === 1 ? '' : 's'} left.` },
      });
    }
    // Out of attempts: even the right code is refused until a new one is sent.
    await expect(check(otp.challenge_id, DEMO_OTP)).rejects.toMatchObject({
      problem: { code: 'rate_limited' },
    });
    await expect(
      repos.auth.resendOtp({ body: { challenge_id: otp.challenge_id } }),
    ).rejects.toMatchObject({
      problem: { code: 'rate_limited' },
    });
    advance(60_000);
    const fresh = await repos.auth.resendOtp({ body: { challenge_id: otp.challenge_id } });
    expect(fresh.attempts_remaining).toBe(5);
    await expect(check(otp.challenge_id, DEMO_OTP)).resolves.toHaveProperty('verification_token');

    const late = await ask();
    advance(10 * 60_000 + 1);
    await expect(check(late.challenge_id, DEMO_OTP)).rejects.toMatchObject({
      problem: { code: 'otp_expired' },
    });
  });

  it('locks the PIN after 5 wrong tries, longer each time, until a right PIN', async () => {
    const { repos, advance } = setup();
    let elapsed = 0;
    const wait = (minutes: number) => {
      advance(minutes * 60_000);
      elapsed += minutes;
    };
    const tryPin = (pin: string) => repos.users.verifyPin({ body: { pin } });
    /** Five wrong PINs; returns how many minutes the lockout lasts. */
    const lockOut = async () => {
      let result = await tryPin('9999');
      for (let i = 1; i < 5; i++) result = await tryPin('9999');
      expect(result).toMatchObject({ valid: false, attempts_remaining: 0 });
      return (Date.parse(result.locked_until!) - START.getTime()) / 60_000 - elapsed;
    };

    expect(await tryPin('9999')).toMatchObject({ valid: false, attempts_remaining: 4 });
    expect((await tryPin('2580')).valid).toBe(true);
    expect(await lockOut()).toBe(30);
    // While locked, even the right PIN is refused.
    expect((await tryPin('2580')).valid).toBe(false);

    wait(30);
    expect(await lockOut()).toBe(120);
    wait(120);
    expect(await lockOut()).toBe(480);

    // A right PIN after the wait starts the count again.
    wait(480);
    expect((await tryPin('2580')).valid).toBe(true);
    expect(await lockOut()).toBe(30);
  });

  it('resets the password only for the account email, with a strong password', async () => {
    const { repos } = setup();
    const reset = async (email: string, new_password: string) => {
      const otp = await repos.auth.forgotPassword({ body: { email } });
      return repos.auth.resetPassword({
        body: { challenge_id: otp.challenge_id, code: DEMO_OTP, new_password },
      });
    };
    // Unknown emails get the same answer, but their code never resets anyone's password.
    await expect(reset('stranger@example.com', 'Kitchen-Mango-River-7')).rejects.toMatchObject({
      problem: { code: 'invalid_otp' },
    });
    await expect(reset('tolu.demo@example.com', 'password123')).rejects.toMatchObject({
      problem: { code: 'weak_password' },
    });
    await reset('Tolu.Demo@example.com', 'Kitchen-Mango-River-7');
    await expect(
      repos.auth.login({ body: { identifier: 'tolu.demo@example.com', password: 'Demo1234!' } }),
    ).rejects.toMatchObject({ problem: { code: 'invalid_credentials' } });
  });

  it('resets the PIN only with a pin_reset step-up, and clears a lockout', async () => {
    const { repos } = setup();
    for (let i = 0; i < 5; i++) await repos.users.verifyPin({ body: { pin: '9999' } });
    expect((await repos.users.verifyPin({ body: { pin: '2580' } })).valid).toBe(false);

    const wrongPurpose = await stepUpToken(repos, 'card_reveal');
    await expect(
      repos.users.resetPin({ body: { pin: '4826' }, stepUpToken: wrongPurpose }),
    ).rejects.toMatchObject({ problem: { status: 403 } });

    const token = await stepUpToken(repos, 'pin_reset');
    await repos.users.resetPin({ body: { pin: '4826' }, stepUpToken: token });
    expect((await repos.users.verifyPin({ body: { pin: '4826' } })).valid).toBe(true);
  });

  it('serves the seeded persona with balances that match the ledger', async () => {
    const { repos } = setup();
    expect((await repos.users.getMe()).preferred_name).toBe('Tolu');
    const { data } = await repos.accounts.list();
    expect(data.map((a) => a.currency)).toEqual(['NGN', 'USD']);
    expect(data[0]!.receiving_details).toMatchObject({ scheme: 'nuban', demo: true });

    const first = await repos.transactions.list({ query: { limit: 5 } });
    expect(first.data).toHaveLength(5);
    expect(first.page.next_cursor).not.toBeNull();
    const second = await repos.transactions.list({
      query: { limit: 5, cursor: first.page.next_cursor! },
    });
    expect(second.data[0]!.id).not.toBe(first.data[0]!.id);
    // The newest NGN transaction's running balance is the account balance.
    const latest = (await repos.transactions.list({ query: { account_id: data[0]!.id, limit: 1 } }))
      .data[0]!;
    expect(latest.balance_after).toEqual(data[0]!.ledger_balance);
  });

  it('sends Nem-to-Nem instantly and replays a repeated idempotency key', async () => {
    const { repos } = setup();
    const account = await ngnAccount(repos);
    const before = await available(repos);
    const body = {
      source_account_id: account.id,
      destination: { kind: 'nem' as const, account_number: '0420270000' },
      amount: naira(5_000),
      save_beneficiary: false,
    };
    const transfer = await repos.transfers.create({ body, idempotencyKey: 'k1' });
    expect(transfer).toMatchObject({ status: 'completed', rail: 'internal', fee: naira(0) });
    expect(await available(repos)).toBe(before - 500_000n);

    const replay = await repos.transfers.create({ body, idempotencyKey: 'k1' });
    expect(replay.id).toBe(transfer.id);
    expect(await available(repos)).toBe(before - 500_000n);

    const conflict = await repos.transfers
      .create({ body: { ...body, amount: naira(6_000) }, idempotencyKey: 'k1' })
      .catch((e: unknown) => e);
    expect(isApiError(conflict, 'idempotency_conflict')).toBe(true);
  });

  it('runs external transfers through the partner saga, including a forced failure', async () => {
    const { repos, advance, store } = setup();
    const account = await ngnAccount(repos);
    const before = await available(repos);
    const body = {
      source_account_id: account.id,
      destination: {
        kind: 'beneficiary' as const,
        beneficiary_id: (await repos.beneficiaries.list()).data.find((b) => b.kind === 'bank')!.id,
      },
      amount: naira(20_000),
      save_beneficiary: false,
    };
    const quote = await repos.transfers.quote({ body });
    expect(quote.fee).toEqual(naira(25));

    const sent = await repos.transfers.create({ body, idempotencyKey: 'ext-1' });
    expect(sent.status).toBe('processing');
    expect(await available(repos)).toBe(before - 2_002_500n);
    advance(5_000);
    expect((await repos.transfers.get({ path: { transfer_id: sent.id } })).status).toBe(
      'completed',
    );
    expect(await available(repos)).toBe(before - 2_002_500n);

    await repos.demo.failNextTransfer();
    const failing = await repos.transfers.create({ body, idempotencyKey: 'ext-2' });
    advance(5_000);
    const failed = await repos.transfers.get({ path: { transfer_id: failing.id } });
    expect(failed.status).toBe('failed');
    expect(failed.timeline.map((e) => e.status)).toContain('reversed');
    expect(await available(repos)).toBe(before - 2_002_500n);
    const txn = (await repos.transactions.list({ query: { limit: 1 } })).data[0]!;
    expect(txn.status).toBe('failed');

    for (const total of (await trialBalance(store)).values()) expect(total.amount).toBe(0n);
  });

  it('delays a large first payment to a new beneficiary unless the customer steps up', async () => {
    const { repos, advance } = setup();
    const account = await ngnAccount(repos);
    const body = {
      source_account_id: account.id,
      destination: {
        kind: 'bank' as const,
        bank_code: '058',
        account_number: '1234567891',
        account_name: 'Anyone',
      },
      amount: naira(150_000),
      save_beneficiary: false,
    };
    expect((await repos.transfers.quote({ body })).cooling_off).toMatchObject({
      reason: 'new_beneficiary',
      delay_minutes: 30,
    });
    const delayed = await repos.transfers.create({ body, idempotencyKey: 'cool-1' });
    expect(delayed.status).toBe('delayed');
    expect(delayed.release_at).not.toBeNull();

    const token = await stepUpToken(repos, 'transfer');
    const now = await repos.transfers.stepUp({
      path: { transfer_id: delayed.id },
      stepUpToken: token,
      idempotencyKey: 'cool-1-up',
    });
    expect(now.status).toBe('processing');
    advance(5_000);
    expect((await repos.transfers.get({ path: { transfer_id: delayed.id } })).status).toBe(
      'completed',
    );

    const waiting = await repos.transfers.create({
      body: { ...body, destination: { ...body.destination, account_number: '1234567892' } },
      idempotencyKey: 'cool-2',
    });
    expect(waiting.status).toBe('delayed');
    advance(31 * 60_000);
    await repos.transfers.list();
    advance(5_000);
    expect((await repos.transfers.get({ path: { transfer_id: waiting.id } })).status).toBe(
      'completed',
    );
  });

  it('blocks outgoing money and freezes cards in panic mode; release needs step-up', async () => {
    const { repos } = setup();
    const account = await ngnAccount(repos);
    const panic = await repos.security.activatePanic();
    expect(panic).toMatchObject({ active: true, outgoing_blocked: true, cards_frozen: 1 });
    expect((await repos.cards.list()).data[0]!.status).toBe('frozen');
    const blocked = await repos.transfers
      .create({
        body: {
          source_account_id: account.id,
          destination: { kind: 'nem', account_number: '0420270000' },
          amount: naira(100),
          save_beneficiary: false,
        },
        idempotencyKey: 'p1',
      })
      .catch((e: unknown) => e);
    expect(isApiError(blocked, 'outgoing_blocked')).toBe(true);
    await expect(repos.security.releasePanic({ stepUpToken: 'nope' })).rejects.toMatchObject({
      code: 'step_up_required',
    });
    await repos.security.releasePanic({ stepUpToken: await stepUpToken(repos, 'unfreeze') });
    expect((await repos.cards.list()).data[0]!.status).toBe('active');
  });

  it('converts currency at a quoted rate and refuses an expired quote', async () => {
    const { repos, advance, store } = setup();
    const { data } = await repos.accounts.list();
    const [ngn, usd] = data as [(typeof data)[number], (typeof data)[number]];
    const quote = await repos.fx.createQuote({
      body: { from_account_id: ngn.id, to_account_id: usd.id, sell_amount: naira(100_000) },
    });
    expect(BigInt(quote.buy.amount_minor)).toBeGreaterThan(5_000n);
    const conversion = await repos.fx.convert({
      body: { quote_id: quote.quote_id },
      idempotencyKey: 'fx-1',
    });
    expect(conversion.buy).toEqual(quote.buy);
    const usdAfter = (await repos.accounts.get({ path: { account_id: usd.id } })).available_balance;
    expect(BigInt(usdAfter.amount_minor) - BigInt(usd.available_balance.amount_minor)).toBe(
      BigInt(quote.buy.amount_minor),
    );

    const stale = await repos.fx.createQuote({
      body: { from_account_id: ngn.id, to_account_id: usd.id, sell_amount: naira(1_000) },
    });
    advance(61_000);
    await expect(
      repos.fx.convert({ body: { quote_id: stale.quote_id }, idempotencyKey: 'fx-2' }),
    ).rejects.toMatchObject({ code: 'quote_expired' });
    for (const total of (await trialBalance(store)).values()) expect(total.amount).toBe(0n);
  });

  it('moves money in and out of goals and keeps half the interest when a lock is broken early', async () => {
    const { repos, advance } = setup();
    const ngn = await ngnAccount(repos);
    const goal = (await repos.savings.listGoals()).data[0]!;
    const saved = await repos.savings.deposit({
      path: { goal_id: goal.id },
      body: { amount: naira(10_000), account_id: ngn.id },
      idempotencyKey: 'g1',
    });
    expect(BigInt(saved.balance.amount_minor) - BigInt(goal.balance.amount_minor)).toBe(1_000_000n);

    const lock = await repos.savings.createLock({
      body: {
        amount: naira(365_000),
        term_days: 365,
        source_account_id: ngn.id,
        accepted_terms: true,
      },
      idempotencyKey: 'l1',
    });
    expect(lock.expected_interest).toEqual(naira(65_700));
    advance(100 * 86_400_000);
    const broken = await repos.savings.breakLock({
      path: { lock_id: lock.id },
      idempotencyKey: 'l1-break',
    });
    // 100 days of 18% on ₦365,000 is ₦18,000; half is kept.
    expect(broken).toMatchObject({ status: 'broken', paid_out: naira(374_000) });
  });

  it('pays an electricity bill and returns a token', async () => {
    const { repos } = setup();
    const ngn = await ngnAccount(repos);
    const customer = await repos.bills.validateCustomer({
      body: { biller_id: 'ikeja-electric-prepaid', customer_id: '45031234567' },
    });
    expect(customer.customer_name).toBeTruthy();
    const payment = await repos.bills.pay({
      body: {
        biller_id: 'ikeja-electric-prepaid',
        customer_id: '45031234567',
        amount: naira(5_000),
        source_account_id: ngn.id,
      },
      idempotencyKey: 'b1',
    });
    expect(payment.status).toBe('completed');
    expect(payment.token).toMatch(/^\d{4}(-\d{4}){4}$/);
  });

  it('lends against salary and takes repayments', async () => {
    const { repos } = setup();
    const ngn = await ngnAccount(repos);
    const eligibility = await repos.credit.getEligibility();
    expect(eligibility.eligible).toBe(true);
    const offer = await repos.credit.createOffer({
      body: { amount: naira(100_000), tenor_days: 60 },
    });
    expect(offer.schedule).toHaveLength(2);
    const loan = await repos.credit.acceptOffer({
      body: { offer_id: offer.offer_id, disbursement_account_id: ngn.id, auto_repay: false },
      idempotencyKey: 'loan-1',
    });
    expect(loan.outstanding).toEqual(offer.total_repayment);
    const repaid = await repos.credit.repay({
      path: { loan_id: loan.id },
      body: { amount: offer.total_repayment, account_id: ngn.id },
      idempotencyKey: 'loan-1-pay',
    });
    expect(repaid.status).toBe('repaid');
  });

  it('lets the assistant prepare a transfer that only moves money once confirmed', async () => {
    const { repos } = setup();
    const before = await available(repos);
    const conversation = await repos.assistant.startConversation();
    const reply = await repos.assistant.sendMessage({
      path: { conversation_id: conversation.id },
      body: { text: 'send 2k to @amaka_o' },
    });
    const block = reply.blocks.find((b) => b.type === 'prepared_action');
    expect(block?.type === 'prepared_action' && block.action.status).toBe('prepared');
    expect(await available(repos)).toBe(before);
    if (block?.type !== 'prepared_action') throw new Error('no action');
    const confirmed = await repos.assistant.confirmAction({
      path: { action_id: block.action.id },
      idempotencyKey: 'a1',
    });
    expect(confirmed.status).toBe('confirmed');
    expect(await available(repos)).toBe(before - 200_000n);
  });

  it('flags scam messages with reasons', async () => {
    const { repos } = setup();
    const result = await repos.security.checkScam({
      body: {
        kind: 'message',
        content:
          'URGENT: your account is blocked. Send your OTP to update BVN at http://nem-bank-verify.com',
      },
    });
    expect(result.verdict).toBe('likely_scam');
    expect(result.reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining(['asks_for_secret', 'lookalike_domain']),
    );
  });

  it('saves every change and reloads it in a new session, and Demo reset reseeds', async () => {
    const store = createMemoryStore();
    const first = setup(store);
    await first.repos.users.updateMe({ body: { preferred_name: 'Tee' } });
    const second = setup(store);
    expect((await second.repos.users.getMe()).preferred_name).toBe('Tee');
    await second.repos.demo.reset();
    expect((await second.repos.users.getMe()).preferred_name).toBe('Tolu');
    expect((await setup(store).repos.users.getMe()).preferred_name).toBe('Tolu');
  });

  it('returns copies, so callers cannot change the bank by mutating a result', async () => {
    const { repos } = setup();
    const me = await repos.users.getMe();
    me.preferred_name = 'Hacked';
    expect((await repos.users.getMe()).preferred_name).toBe('Tolu');
  });
});
