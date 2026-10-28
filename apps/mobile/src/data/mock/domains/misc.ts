import type { Schema } from '@nem/contracts';
import { formatMoney, money } from '@nem/shared';

import { problem } from '../../errors';
import type { DemoRepo, PrivacyRepo, RealtimeRepo } from '../../repositories';
import { addDays, addMinutes, positive } from '../convert';
import { demoFund, receiveExternal, transferInternal } from '../ledger';
import type { MockBank } from '../runtime';
import { customerTransactions } from '../views';

import { setKycTier } from './kyc';

/** NDPA: data subject requests are answered within 30 days. */
const PRIVACY_DAYS = 30;
const MAX_TIME_TRAVEL_DAYS = 400;

export function privacyRepo(bank: MockBank): PrivacyRepo {
  const request = (kind: Schema<'PrivacyRequest'>['kind']) => {
    const open = bank.world.privacyRequests.find(
      (r) => r.kind === kind && r.status !== 'completed' && r.status !== 'rejected',
    );
    if (open) return open;
    const r: Schema<'PrivacyRequest'> = {
      id: bank.id(),
      kind,
      status: 'received',
      requested_at: bank.nowIso(),
      completes_by: addDays(bank.now(), PRIVACY_DAYS).toISOString(),
    };
    bank.world.privacyRequests.push(r);
    return r;
  };
  return {
    async requestExport() {
      return request('export');
    },
    async requestDeletion({ stepUpToken }) {
      bank.consumeStepUp(stepUpToken, 'account_deletion');
      return request('deletion');
    },
  };
}

export function realtimeRepo(bank: MockBank): RealtimeRepo {
  return {
    async createTicket() {
      // The mock pushes events in-process (T3.8); the URL only marks the transport.
      return {
        ticket: `mock_ticket_${bank.id().replaceAll('-', '')}`,
        url: 'mock://realtime',
        expires_at: addMinutes(bank.now(), 1).toISOString(),
      };
    },
  };
}

export function demoRepo(bank: MockBank): DemoRepo {
  const transaction = (id: string) => customerTransactions(bank).find((t) => t.id === id)!;
  return {
    async fundWallet({ body, idempotencyKey }) {
      const account = bank.ownAccount(body.account_id);
      const amount = positive(body.amount, account.currency);
      const id = bank.id();
      const entry = demoFund(bank.ledger, {
        toAccountId: account.id,
        amount,
        tier: bank.tier(),
        idempotencyKey,
        metadata: {
          txns: [
            {
              id,
              accountId: account.id,
              direction: 'credit',
              type: 'deposit',
              category: 'other',
              narration: 'Demo money added',
              counterparty: { name: 'Demo Controls' },
            },
          ],
        },
      });
      return transaction((entry.metadata.txns as { id: string }[])[0]!.id);
    },
    async inboundTransfer({ body, idempotencyKey }) {
      const account = bank.ownAccount(body.account_id);
      const amount = positive(body.amount, account.currency);
      const entry = receiveExternal(bank.ledger, {
        toAccountId: account.id,
        amount,
        tier: bank.tier(),
        reference: bank.reference(),
        idempotencyKey,
        metadata: {
          txns: [
            {
              id: bank.id(),
              accountId: account.id,
              direction: 'credit',
              type: 'transfer_in',
              category: 'transfers',
              narration: body.narration?.trim() || `Transfer from ${body.sender_name}`,
              counterparty: {
                name: body.sender_name,
                bank_name: body.sender_bank ?? 'Guaranty Trust Bank',
                account_number_masked: '******4821',
              },
            },
          ],
        },
      });
      const txn = transaction((entry.metadata.txns as { id: string }[])[0]!.id);
      bank.notify({
        category: 'transactions',
        title: `${body.sender_name} sent you money`,
        body: txn.narration,
        deep_link: `nembank://transactions/${txn.id}`,
      });
      return txn;
    },
    async failNextTransfer() {
      bank.world.failNextTransfer = true;
    },
    async timeTravel({ body }) {
      if (!Number.isInteger(body.days) || body.days < 1)
        throw problem(422, 'validation_failed', 'Travel forward by whole days');
      if (bank.world.clockOffsetDays + body.days > MAX_TIME_TRAVEL_DAYS) {
        throw problem(
          422,
          'validation_failed',
          `The demo can travel up to ${MAX_TIME_TRAVEL_DAYS} days ahead`,
        );
      }
      bank.world.clockOffsetDays += body.days;
      bank.tick();
      return { now: bank.nowIso(), offset_days: bank.world.clockOffsetDays };
    },
    async setKycTier({ body }) {
      setKycTier(bank, body.tier);
    },
    async reset() {
      await bank.reset();
    },
  };
}

/**
 * Ambient activity (Demo Controls): a friend sends a small amount, so the home
 * screen shows money arriving in realtime without anyone tapping anything.
 */
export function ambientIncoming(bank: MockBank, random: () => number): void {
  const ngn = bank.accountIn('NGN');
  const friend = bank.world.people[Math.floor(random() * bank.world.people.length)];
  if (!ngn || !friend) return;
  const amount = money(BigInt(Math.round(1 + random() * 9)) * 100_000n, 'NGN');
  const notes = ['For the suya', 'Fuel money', 'Thanks for yesterday', 'Your share', 'Small chops'];
  const note = notes[Math.floor(random() * notes.length)]!;
  transferInternal(bank.ledger, {
    fromAccountId: friend.accountId,
    toAccountId: ngn.id,
    recipientTier: bank.tier(),
    amount,
    reference: bank.reference(),
    idempotencyKey: `ambient:${bank.id()}`,
    limits: { tier: friend.tier },
    metadata: {
      txns: [
        {
          id: bank.id(),
          accountId: ngn.id,
          direction: 'credit',
          type: 'transfer_in',
          category: 'transfers',
          narration: note,
          counterparty: { name: `${friend.firstName} ${friend.lastName}`, nemtag: friend.nemtag },
        },
      ],
    },
  });
  bank.notify({
    category: 'transactions',
    title: `${friend.firstName} sent you ${formatMoney(amount)}`,
    body: note,
    deep_link: 'nembank://home',
  });
}
