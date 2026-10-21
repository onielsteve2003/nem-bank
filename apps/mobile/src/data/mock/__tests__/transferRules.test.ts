import type { Repositories } from '../../repositories';
import { isApiError } from '../../errors';
import { createMockRepositories } from '../index';
import { createMemoryStore } from '../persistence/types';

// The limit and fee rules the mock bank applies to every transfer (TRF-4), as
// the customer meets them: in the quote first, then again when the money moves.

const START = new Date('2026-10-17T12:00:00.000Z');
const naira = (major: number | string) => ({
  amount_minor: String(Math.round(Number(major) * 100)),
  currency: 'NGN' as const,
});

function setup() {
  let now = START;
  const repos = createMockRepositories({
    store: createMemoryStore(),
    clock: () => now,
    simulation: { latency: 'off' },
  });
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  return { repos, advance };
}

async function bodyFor(repos: Repositories, kind: 'nem' | 'bank', major: number | string) {
  const { data: accounts } = await repos.accounts.list();
  const { data: beneficiaries } = await repos.beneficiaries.list();
  return {
    source_account_id: accounts.find((a) => a.currency === 'NGN')!.id,
    destination: {
      kind: 'beneficiary' as const,
      beneficiary_id: beneficiaries.find((b) => b.kind === kind)!.id,
    },
    amount: naira(major),
    save_beneficiary: false,
  };
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e,
  );

describe('transfer fees', () => {
  it('prices Nem-to-Nem transfers at zero, with nothing on top', async () => {
    const { repos } = setup();
    const quote = await repos.transfers.quote({ body: await bodyFor(repos, 'nem', 75_000) });
    expect(quote).toMatchObject({ rail: 'internal', fee: naira(0), total_debit: naira(75_000) });
    expect(quote.fees).toEqual([]);
  });

  it.each([
    ['5000', '10'],
    ['5000.01', '25'],
    ['50000', '25'],
    ['50000.01', '50'],
  ])(
    'charges ₦%s to another bank a ₦%s fee, itemised and added to the debit',
    async (amount, fee) => {
      const { repos } = setup();
      const quote = await repos.transfers.quote({ body: await bodyFor(repos, 'bank', amount) });
      expect(quote.fee).toEqual(naira(fee));
      expect(quote.fees).toEqual([
        { code: 'transfer_fee', label: 'Transfer fee', amount: naira(fee) },
      ]);
      expect(quote.total_debit).toEqual(naira(Number(amount) + Number(fee)));
    },
  );

  it('debits the amount plus the quoted fee when the transfer is made', async () => {
    const { repos } = setup();
    const body = await bodyFor(repos, 'bank', 4_000);
    const sent = await repos.transfers.create({ body, idempotencyKey: 'fee-1' });
    expect(sent).toMatchObject({ fee: naira(10), total_debit: naira(4_010) });
  });
});

describe('transfer limits', () => {
  it('uses the customer’s own daily limit when it is below the KYC tier’s', async () => {
    const { repos } = setup();
    let quote = await repos.transfers.quote({ body: await bodyFor(repos, 'nem', 1_000) });
    expect(quote.limits).toMatchObject({ kyc_tier: 3, daily_limit: naira(5_000_000) });

    await repos.security.setLimits({ body: { daily_limit: naira(30_000), single_limit: null } });
    quote = await repos.transfers.quote({ body: await bodyFor(repos, 'nem', 1_000) });
    expect(quote.limits).toMatchObject({
      daily_limit: naira(30_000),
      remaining_today: naira(30_000),
    });
  });

  it('counts what was sent today and refuses the transfer that would pass the limit', async () => {
    const { repos } = setup();
    await repos.security.setLimits({ body: { daily_limit: naira(30_000), single_limit: null } });
    await repos.transfers.create({
      body: await bodyFor(repos, 'nem', 20_000),
      idempotencyKey: 'day-1',
    });

    const quote = await repos.transfers.quote({ body: await bodyFor(repos, 'nem', 15_000) });
    expect(quote.limits).toMatchObject({
      used_today: naira(20_000),
      remaining_today: naira(10_000),
    });

    const refused = await failure(
      repos.transfers.create({
        body: await bodyFor(repos, 'nem', 15_000),
        idempotencyKey: 'day-2',
      }),
    );
    expect(isApiError(refused, 'limit_exceeded')).toBe(true);
    expect((refused as { problem: { detail?: string } }).problem.detail).toBe(
      'You can send ₦10,000.00 more today.',
    );
    // Exactly what is left still goes.
    const last = await repos.transfers.create({
      body: await bodyFor(repos, 'nem', 10_000),
      idempotencyKey: 'day-3',
    });
    expect(last.status).toBe('completed');
  });

  it('counts the principal only, not the fee, against the daily limit', async () => {
    const { repos } = setup();
    await repos.security.setLimits({ body: { daily_limit: naira(30_000), single_limit: null } });
    await repos.transfers.create({
      body: await bodyFor(repos, 'bank', 20_000),
      idempotencyKey: 'fee-day-1',
    });
    const quote = await repos.transfers.quote({ body: await bodyFor(repos, 'nem', 1_000) });
    expect(quote.limits.remaining_today).toEqual(naira(10_000));
  });

  it('starts a fresh daily limit at midnight in Lagos', async () => {
    const { repos, advance } = setup();
    await repos.security.setLimits({ body: { daily_limit: naira(30_000), single_limit: null } });
    await repos.transfers.create({
      body: await bodyFor(repos, 'nem', 30_000),
      idempotencyKey: 'reset-1',
    });
    // 12:00 UTC is 13:00 in Lagos: 11 hours to midnight there.
    advance(11 * 60 * 60 * 1000);
    const quote = await repos.transfers.quote({ body: await bodyFor(repos, 'nem', 1_000) });
    expect(quote.limits.remaining_today).toEqual(naira(30_000));
  });

  it('refuses a transfer above the customer’s own single-transfer limit', async () => {
    const { repos } = setup();
    await repos.security.setLimits({ body: { daily_limit: null, single_limit: naira(5_000) } });
    const refused = await failure(
      repos.transfers.create({ body: await bodyFor(repos, 'nem', 6_000), idempotencyKey: 'one-1' }),
    );
    expect(isApiError(refused, 'limit_exceeded')).toBe(true);
    const ok = await repos.transfers.create({
      body: await bodyFor(repos, 'nem', 5_000),
      idempotencyKey: 'one-2',
    });
    expect(ok.status).toBe('completed');
  });

  it('never lets a self-set limit go above the KYC cap', async () => {
    const { repos } = setup();
    const refused = await failure(
      repos.security.setLimits({ body: { daily_limit: naira(6_000_000), single_limit: null } }),
    );
    expect(isApiError(refused, 'limit_exceeded')).toBe(true);
  });
});
