import type { StaffRole } from '@nem/contracts';
import { describe, expect, it } from 'vitest';

import { lagosDate, shiftDate } from '@/lib/dates';

import { isApiError } from '../errors';
import { repositoriesFromDispatcher } from '../repositories';
import { switchDemoRole } from './auth';
import { customerId } from './customerSeed';
import { disputeId } from './disputeSeed';
import { createMockDispatcher } from './index';
import { post, systemAccountId } from './ledgerSeed';
import { createMockState, type MockState } from './state';

function reposAs(role: StaffRole, state: MockState = createMockState()) {
  const { access_token } = switchDemoRole(state, role);
  return repositoriesFromDispatcher(
    createMockDispatcher({ latencyMs: 0, state, getAccessToken: () => access_token }),
  );
}

describe('mock ledger', () => {
  it('opens every customer account at the balance its 360 shows', () => {
    const state = createMockState();
    for (const { view } of state.customers.values()) {
      for (const a of view.accounts) {
        expect(state.ledger.accounts.get(a.id)!.balance).toEqual(a.ledger_balance);
      }
    }
  });

  it('proves the trial balance nets to zero in every currency', async () => {
    const tb = await reposAs('finance').ledger.trialBalance();
    expect(tb.balanced).toBe(true);
    expect(tb.currencies.map((c) => c.currency)).toEqual(['NGN', 'USD']);
    for (const line of tb.currencies) {
      expect(line.net.amount_minor).toBe('0');
      expect(line.total_debits).toEqual(line.total_credits);
    }
  });

  it('refuses an entry that does not balance', () => {
    const state = createMockState();
    expect(() =>
      post(state.ledger, {
        kind: 'manual_adjustment',
        reference: 'BAD',
        at: new Date().toISOString(),
        postings: [
          [systemAccountId('suspense', 'NGN'), -100n],
          [systemAccountId('fee_income', 'NGN'), 99n],
        ],
      }),
    ).toThrow(/Unbalanced NGN/);
  });

  it('posts a dispute refund through the ledger and still balances', async () => {
    const state = createMockState();
    await reposAs('compliance', state).disputes.decide({
      path: { dispute_id: disputeId(1) },
      body: {
        outcome: 'refund',
        refund_amount: { amount_minor: '4500000', currency: 'NGN' },
        note: 'Duplicate confirmed.',
      },
      idempotencyKey: 'ledger-refund',
    });
    const repos = reposAs('finance', state);
    const entries = await repos.ledger.listEntries({ query: { kind: 'dispute_refund' } });
    expect(entries.data).toHaveLength(1);
    const ngn = state.customers.get(customerId(1))!.view.accounts[0]!;
    expect(state.ledger.accounts.get(ngn.id)!.balance).toEqual(ngn.ledger_balance);
    expect((await repos.ledger.trialBalance()).balanced).toBe(true);
  });

  it('lists postings newest first with running balances', async () => {
    const state = createMockState();
    const id = state.customers.get(customerId(1))!.view.accounts[0]!.id;
    const postings = await reposAs('admin', state).ledger.listPostings({
      path: { ledger_account_id: id },
    });
    expect(postings.data[0]!.balance_after).toEqual(state.ledger.accounts.get(id)!.balance);
    const times = postings.data.map((p) => p.created_at);
    expect(times).toEqual([...times].sort().reverse());
  });

  it('reconciles yesterday against the partner file and refuses today', async () => {
    const state = createMockState();
    const repos = reposAs('finance', state);
    const today = lagosDate(state.now());
    const report = await repos.ledger.reconciliation({ query: { date: shiftDate(today, -1) } });
    expect(report.matched).toBeGreaterThan(0);
    expect(report.unmatched).toBe(report.items.length);
    expect(report.items.map((i) => i.status)).toContain('missing_at_partner');

    const error = await repos.ledger.reconciliation({ query: { date: today } }).catch((e) => e);
    expect(isApiError(error) && error.status).toBe(404);
  });

  it('keeps the ledger to Finance and Admin', async () => {
    const error = await reposAs('support')
      .ledger.trialBalance()
      .catch((e: unknown) => e);
    expect(isApiError(error) && error.status).toBe(403);
  });
});
