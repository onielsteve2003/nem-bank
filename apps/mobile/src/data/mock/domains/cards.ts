import type { Schema } from '@nem/contracts';

import { problem } from '../../errors';
import type { CardsRepo } from '../../repositories';
import { addDays, newestFirst, notFound, paginate, positive } from '../convert';
import type { MockBank } from '../runtime';
import { customerTransactions } from '../views';
import type { CardRecord } from '../world';

const MAX_ACTIVE_CARDS = 5;
const REVEAL_SECONDS = 30;

/** Merchant category codes for the categories card spending falls into. */
const MCC: Partial<Record<Schema<'Category'>, string>> = {
  food: '5812',
  groceries: '5411',
  transport: '4121',
  subscriptions: '4899',
  shopping: '5311',
  entertainment: '7832',
};

export function cardView({ pan: _pan, cvv: _cvv, ...card }: CardRecord): Schema<'Card'> {
  return card;
}

const randomDigits = (count: number) =>
  Array.from({ length: count }, () => Math.floor(Math.random() * 10)).join('');

export function cardsRepo(bank: MockBank): CardsRepo {
  const find = (id: string): CardRecord => {
    const card = bank.world.cards.find((c) => c.id === id);
    if (!card) throw notFound('Card');
    return card;
  };
  const live = (card: CardRecord) => {
    if (card.status === 'terminated' || card.status === 'used') {
      throw problem(409, 'invalid_state', 'This card is no longer active');
    }
    return card;
  };
  const issue = (input: Schema<'CreateCardRequest'>): CardRecord => {
    bank.requireTier(2, 'Cards');
    const account = bank.ownAccount(input.account_id);
    if (account.currency !== 'NGN' && account.currency !== 'USD') {
      throw problem(422, 'validation_failed', 'Cards are available for NGN and USD');
    }
    const active = bank.world.cards.filter((c) => c.status === 'active' || c.status === 'frozen');
    if (active.length >= MAX_ACTIVE_CARDS) {
      throw problem(409, 'limit_reached', `You can have up to ${MAX_ACTIVE_CARDS} cards`);
    }
    if (input.type === 'merchant_locked' && !input.merchant_lock) {
      throw problem(422, 'validation_failed', 'Pick the merchant this card is locked to');
    }
    const usd = account.currency === 'USD';
    const pan = `${usd ? '453201' : '506099'}${randomDigits(10)}`;
    const expiry = addDays(bank.now(), 4 * 365);
    const card: CardRecord = {
      id: bank.id(),
      account_id: account.id,
      currency: account.currency,
      type: input.type,
      status: 'active',
      network: usd ? 'nem_visa' : 'nem_verve',
      last4: pan.slice(-4),
      expiry_month: expiry.getUTCMonth() + 1,
      expiry_year: expiry.getUTCFullYear(),
      name_on_card: `${bank.user.first_name} ${bank.user.last_name}`.toUpperCase(),
      nickname: input.nickname?.trim() || null,
      design: input.design,
      controls: {
        spend_limit: input.spend_limit
          ? { ...input.spend_limit, amount: input.spend_limit.amount }
          : null,
        online_enabled: true,
        international_enabled: usd,
        merchant_lock: input.merchant_lock ?? null,
      },
      frozen_by_panic: false,
      physical: false,
      created_at: bank.nowIso(),
      pan,
      cvv: randomDigits(3),
    };
    if (input.spend_limit) positive(input.spend_limit.amount, account.currency);
    bank.world.cards.push(card);
    return card;
  };

  return {
    async list() {
      return { data: newestFirst(bank.world.cards).map(cardView) };
    },
    async create({ body, idempotencyKey }) {
      return cardView(
        bank.idempotent(
          idempotencyKey,
          body,
          (id) => bank.world.cards.find((c) => c.id === id),
          () => issue(body),
        ),
      );
    },
    async requestPhysical() {
      throw problem(403, 'paid_feature_required', 'Physical cards need a card partner', {
        detail: 'Printing and delivering cards needs a card manufacturing partner (CARD-8).',
        feature: 'physical_cards',
      });
    },
    async get({ path }) {
      return cardView(find(path.card_id));
    },
    async updateControls({ path, body }) {
      const card = live(find(path.card_id));
      if (body.nickname !== undefined) card.nickname = body.nickname?.trim() || null;
      if (body.spend_limit !== undefined) {
        if (body.spend_limit) positive(body.spend_limit.amount, card.currency);
        card.controls.spend_limit = body.spend_limit;
      }
      if (body.online_enabled !== undefined) card.controls.online_enabled = body.online_enabled;
      if (body.international_enabled !== undefined) {
        card.controls.international_enabled = body.international_enabled;
      }
      if (body.merchant_lock !== undefined) card.controls.merchant_lock = body.merchant_lock;
      return cardView(card);
    },
    async freeze({ path }) {
      const card = live(find(path.card_id));
      card.status = 'frozen';
      return cardView(card);
    },
    async unfreeze({ path, stepUpToken }) {
      const card = live(find(path.card_id));
      if (card.frozen_by_panic) {
        if (bank.world.panic.active) {
          throw problem(409, 'invalid_state', 'Release panic mode first', {
            detail: 'Panic mode froze this card. Releasing it unfreezes every card at once.',
          });
        }
        bank.consumeStepUp(stepUpToken, 'unfreeze');
        card.frozen_by_panic = false;
      }
      card.status = 'active';
      return cardView(card);
    },
    async reveal({ path, stepUpToken }) {
      const card = live(find(path.card_id));
      bank.consumeStepUp(stepUpToken, 'card_reveal');
      return {
        card_id: card.id,
        pan: card.pan,
        cvv: card.cvv,
        expiry_month: card.expiry_month,
        expiry_year: card.expiry_year,
        visible_until: new Date(bank.now().getTime() + REVEAL_SECONDS * 1000).toISOString(),
      };
    },
    async terminate({ path }) {
      const card = find(path.card_id);
      card.status = 'terminated';
      return cardView(card);
    },
    async replace({ path, idempotencyKey }) {
      const replacement = bank.idempotent(
        idempotencyKey,
        path,
        (id) => bank.world.cards.find((c) => c.id === id),
        () => {
          const old = live(find(path.card_id));
          old.status = 'terminated';
          return issue({
            account_id: old.account_id,
            type: old.type,
            nickname: old.nickname ?? undefined,
            design: old.design,
            merchant_lock: old.controls.merchant_lock ?? undefined,
            spend_limit: old.controls.spend_limit ?? undefined,
          });
        },
      );
      return cardView(replacement);
    },
    async listTransactions({ path, query }) {
      const card = find(path.card_id);
      const items: Schema<'CardTransaction'>[] = customerTransactions(bank)
        .filter((t) => t.card_id === card.id)
        .map((t) => ({
          id: t.id,
          card_id: card.id,
          merchant: {
            name: t.counterparty.name,
            mcc: MCC[t.category] ?? '5999',
            country: 'NG',
          },
          amount: t.amount,
          billing_amount: t.amount,
          status: t.status === 'reversed' ? 'reversed' : 'settled',
          decline_reason: null,
          transaction_id: t.id,
          authorized_at: t.created_at,
          settled_at: t.created_at,
        }));
      return paginate(items, query);
    },
  };
}
