import type { StaffRole } from '@nem/contracts';
import { describe, expect, it } from 'vitest';

import { isApiError } from '../errors';
import { repositoriesFromDispatcher } from '../repositories';
import { switchDemoRole } from './auth';
import { customerId } from './customerSeed';
import { disputeId } from './disputeSeed';
import { createMockDispatcher } from './index';
import { conversationId } from './supportSeed';
import { createMockState, type MockState } from './state';

function reposAs(role: StaffRole, state: MockState = createMockState()) {
  const { access_token } = switchDemoRole(state, role);
  return repositoriesFromDispatcher(
    createMockDispatcher({ latencyMs: 0, state, getAccessToken: () => access_token }),
  );
}

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!isApiError(error)) throw new Error('expected an API error');
  return error;
}

// Seed order: 1 Adaeze ₦45,000 duplicate, 5 Tolulope ₦250,000 unauthorised (above threshold).
const ADAEZE = disputeId(1);
const TOLULOPE = disputeId(5);

describe('mock disputes', () => {
  it('lists open disputes oldest first and filters by outcome', async () => {
    const repos = reposAs('support');
    const open = await repos.disputes.list();
    const raised = open.data.map((d) => d.dispute.created_at);
    expect(raised).toEqual([...raised].sort());
    expect(open.data.every((d) => !d.dispute.status.startsWith('resolved'))).toBe(true);
    const refunded = await repos.disputes.list({ query: { status: 'resolved_refunded' } });
    expect(refunded.data[0]!.dispute.refund).toEqual({ amount_minor: '1000000', currency: 'NGN' });
  });

  it('refunds a small dispute at once and credits the customer', async () => {
    const state = createMockState();
    const adaeze = state.customers.get(customerId(1))!.view;
    const before = BigInt(adaeze.accounts[0]!.ledger_balance.amount_minor);
    const openBefore = adaeze.open_cases.disputes;
    const body = {
      outcome: 'refund' as const,
      refund_amount: { amount_minor: '4500000', currency: 'NGN' as const },
      note: 'Jumia confirmed the duplicate charge.',
    };
    const repos = reposAs('compliance', state);
    const result = await repos.disputes.decide({
      path: { dispute_id: ADAEZE },
      body,
      idempotencyKey: 'k1',
    });
    expect(result).toMatchObject({ dispute: { status: 'resolved_refunded' } });
    expect(BigInt(adaeze.accounts[0]!.ledger_balance.amount_minor)).toBe(before + 4_500_000n);
    expect(adaeze.recent_transactions[0]).toMatchObject({ type: 'dispute_refund' });
    expect(adaeze.open_cases.disputes).toBe(openBefore - 1);

    // The same key again replays the first answer; nothing is refunded twice.
    await repos.disputes.decide({ path: { dispute_id: ADAEZE }, body, idempotencyKey: 'k1' });
    expect(BigInt(adaeze.accounts[0]!.ledger_balance.amount_minor)).toBe(before + 4_500_000n);
  });

  it('sends a large refund to maker-checker instead of paying it', async () => {
    const state = createMockState();
    const repos = reposAs('admin', state);
    const body = {
      outcome: 'refund' as const,
      refund_amount: { amount_minor: '25000000', currency: 'NGN' as const },
      note: 'Customer was in Lagos; card present fraud.',
    };
    const result = await repos.disputes.decide({
      path: { dispute_id: TOLULOPE },
      body,
      idempotencyKey: 'k2',
    });
    expect(result).toMatchObject({ action: 'dispute_refund', status: 'pending' });
    expect(state.disputes.get(TOLULOPE)!.dispute.status).toBe('under_review');

    const again = await rejection(
      repos.disputes.decide({ path: { dispute_id: TOLULOPE }, body, idempotencyKey: 'k3' }),
    );
    expect(again.code).toBe('approval_pending');
  });

  it('refuses a refund above the disputed amount and lets support only read', async () => {
    const tooMuch = await rejection(
      reposAs('compliance').disputes.decide({
        path: { dispute_id: ADAEZE },
        body: {
          outcome: 'refund',
          refund_amount: { amount_minor: '4500001', currency: 'NGN' },
          note: 'Refund the lot.',
        },
        idempotencyKey: 'k4',
      }),
    );
    expect(tooMuch.status).toBe(422);
    const forbidden = await rejection(
      reposAs('support').disputes.decide({
        path: { dispute_id: ADAEZE },
        body: { outcome: 'decline', note: 'Not our problem.' },
        idempotencyKey: 'k5',
      }),
    );
    expect(forbidden.status).toBe(403);
  });
});

describe('mock support inbox', () => {
  it('puts the longest waiting chat first and clears unread when an agent reads it', async () => {
    const repos = reposAs('support');
    const inbox = await repos.support.listConversations();
    const waits = inbox.data.map((c) => c.waiting_minutes);
    expect(waits).toEqual([...waits].sort((a, b) => b - a));
    expect(inbox.data[0]!.customer.name).toBe('Emeka Nwosu');
    expect(inbox.data[0]!.conversation.unread_count).toBe(2);

    const messages = await repos.support.listMessages({
      path: { conversation_id: conversationId(1) },
    });
    expect(messages.data[0]!.body).toMatch(/urgent/);
    const after = await repos.support.listConversations();
    expect(
      after.data.find((c) => c.conversation.id === conversationId(1))!.conversation.unread_count,
    ).toBe(0);
  });

  it('assigns an unassigned chat to the first agent who replies, then resolves it', async () => {
    const state = createMockState();
    const repos = reposAs('support', state);
    const id = conversationId(4);
    await repos.support.sendMessage({
      path: { conversation_id: id },
      body: { body: 'I’ve resent the code. Check your spam folder too.' },
    });
    const mine = await repos.support.listConversations({ query: { assigned_to_me: true } });
    expect(mine.data.find((c) => c.conversation.id === id)).toMatchObject({
      conversation: { status: 'waiting_on_customer', assigned_agent: 'Chidi' },
      waiting_minutes: 0,
    });

    const resolved = await repos.support.resolve({ path: { conversation_id: id } });
    expect(resolved.conversation.status).toBe('resolved');
    const closed = await rejection(
      repos.support.sendMessage({ path: { conversation_id: id }, body: { body: 'Hello?' } }),
    );
    expect(closed.status).toBe(409);
  });
});
