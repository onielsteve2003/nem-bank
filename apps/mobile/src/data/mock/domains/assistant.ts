import type { Schema } from '@nem/contracts';
import { formatMoney, parseMajor } from '@nem/shared';

import { problem } from '../../errors';
import type { AssistantRepo, Repositories } from '../../repositories';
import { addMinutes, api, newestFirst, notFound, paginate } from '../convert';
import type { MockBank } from '../runtime';
import { accountView, customerTransactions, personByNemtag } from '../views';

// The assistant's offline fallback (AI-3): intent rules instead of an LLM. Like the
// real one it only *prepares* money actions; confirming runs them through the same
// repositories (and rules) as the screens.

const ACTION_TTL_MINUTES = 10;
const AI: Schema<'AiMeta'> = {
  feature: 'assistant',
  model_version: 'rules-mock-1',
  explanation:
    'Offline helper: it understands balances, spending, sending money, saving and freezing cards.',
  fallback_used: true,
};

type Block = Schema<'AssistantBlock'>;
const text = (value: string): Block => ({ type: 'text', text: value });

const AMOUNT = /(?:₦|ngn|n)?\s?(\d[\d,]*(?:\.\d{1,2})?)\s?(k)?/i;

function amountFrom(input: string) {
  const m = AMOUNT.exec(input.replace(/naira/i, ''));
  if (!m) return null;
  const major = m[1]!.replaceAll(',', '');
  const money = parseMajor(m[2] ? String(Number(major) * 1000) : major, 'NGN');
  return money.amount > 0n ? money : null;
}

export function assistantRepo(bank: MockBank, repos: () => Repositories): AssistantRepo {
  const conversation = (id: string) => {
    const c = bank.world.assistant.conversations.find((x) => x.id === id);
    if (!c) throw notFound('Conversation');
    return c;
  };
  const action = (id: string) => {
    const a = bank.world.assistant.actions.find((x) => x.id === id);
    if (!a) throw notFound('Action');
    if (a.status === 'prepared' && a.expires_at < bank.nowIso()) a.status = 'expired';
    return a;
  };
  const say = (conversationId: string, role: 'user' | 'assistant', blocks: Block[]) => {
    const message = {
      id: bank.id(),
      conversationId,
      role,
      blocks,
      created_at: bank.nowIso(),
      ai: role === 'assistant' ? AI : null,
    };
    bank.world.assistant.messages.push(message);
    const { conversationId: _c, ...view } = message;
    return view;
  };
  const prepare = (
    kind: Schema<'PreparedActionKind'>,
    summary: string,
    details: Schema<'PreparedAction'>['details'],
    quote: Schema<'TransferQuote'> | null = null,
  ): Block => {
    const prepared: Schema<'PreparedAction'> = {
      id: bank.id(),
      kind,
      summary,
      details,
      quote,
      status: 'prepared',
      expires_at: addMinutes(bank.now(), ACTION_TTL_MINUTES).toISOString(),
      result: null,
    };
    bank.world.assistant.actions.push(prepared);
    return { type: 'prepared_action', action: prepared };
  };

  async function answer(prompt: Schema<'AssistantPrompt'>): Promise<Block[]> {
    const input = prompt.text.trim();
    const lower = input.toLowerCase();
    const pidgin = prompt.language === 'pcm';
    const ngn = bank.accountIn('NGN');
    if (/balance|how much (do )?i (have|get)/.test(lower) && ngn) {
      const view = accountView(bank, ngn);
      const amount = formatMoney({
        amount: BigInt(view.available_balance.amount_minor),
        currency: 'NGN',
      });
      return [
        text(
          pidgin
            ? `You get ${amount} for your naira account.`
            : `You have ${amount} available in your naira account.`,
        ),
      ];
    }
    if (/spen[dt]|spending/.test(lower)) {
      const spending = await repos().insights.getSpending();
      return [
        text(
          `This month you have spent ${formatMoney({ amount: BigInt(spending.total.amount_minor), currency: 'NGN' })}.`,
        ),
        {
          type: 'chart',
          chart: 'donut',
          title: 'Spending by category',
          series: spending.categories
            .slice(0, 5)
            .map((c) => ({ label: c.category.replaceAll('_', ' '), amount: c.amount })),
        },
      ];
    }
    if (/transactions|history|recent/.test(lower)) {
      return [
        text('Here are your latest transactions.'),
        { type: 'transactions', transactions: customerTransactions(bank).slice(0, 5) },
      ];
    }
    const send = /(?:send|pay|transfer)\s+(.+?)\s+to\s+@?([a-z0-9_]+)/i.exec(input);
    if (send && ngn) {
      const amount = amountFrom(send[1]!);
      const person = personByNemtag(bank, send[2]!);
      if (!amount) return [text('How much should I send? For example: "send ₦5,000 to @amaka_o".')];
      if (!person)
        return [text(`I could not find @${send[2]} on Nem. Check the Nemtag and try again.`)];
      const details: Schema<'CreateTransferRequest'> = {
        source_account_id: ngn.id,
        destination: { kind: 'nem', account_number: person.accountNumber },
        amount: api(amount),
        narration: 'Sent with Nem assistant',
        save_beneficiary: false,
      };
      const quote = await repos().transfers.quote({ body: details });
      return [
        text('I have prepared this transfer. Check it, then confirm with your PIN.'),
        prepare(
          'transfer',
          `Send ${formatMoney(amount)} to ${person.firstName} ${person.lastName} (@${person.nemtag})`,
          details,
          quote,
        ),
      ];
    }
    const save = /save\s+(.+?)(?:\s+(?:to|into|for)\s+(.+))?$/i.exec(input);
    if (save && ngn) {
      const amount = amountFrom(save[1]!);
      const goals = bank.world.goals.filter((g) => g.status === 'active');
      const goal =
        goals.find((g) => save[2] && g.name.toLowerCase().includes(save[2].toLowerCase())) ??
        goals[0];
      if (!amount || !goal)
        return [
          text(
            goal ? 'How much should I save?' : 'Create a savings goal first, then ask me again.',
          ),
        ];
      return [
        text(`Ready to move it into ${goal.name}.`),
        prepare('savings_deposit', `Save ${formatMoney(amount)} to ${goal.emoji} ${goal.name}`, {
          amount: api(amount),
          account_id: ngn.id,
        }),
      ];
    }
    if (/freeze/.test(lower)) {
      const card = bank.world.cards.find((c) => c.status === 'active');
      if (!card) return [text('You have no active card to freeze.')];
      return [
        text('I can freeze it right away. You can unfreeze it any time.'),
        prepare('card_freeze', `Freeze card •••• ${card.last4}`, { card_id: card.id }),
      ];
    }
    return [
      text(
        pidgin
          ? 'I fit check your balance, show wetin you don spend, send money or save for you. Try "send 5k to @amaka_o".'
          : 'I can check your balance, show your spending, send money, save to a goal or freeze a card. Try "send ₦5,000 to @amaka_o".',
      ),
    ];
  }

  return {
    async startConversation() {
      if (!bank.world.preferences.ai.assistant) {
        throw problem(403, 'feature_disabled', 'The assistant is off', {
          detail: 'Turn it on in Settings → AI features.',
        });
      }
      const c: Schema<'AssistantConversation'> = {
        id: bank.id(),
        created_at: bank.nowIso(),
        ai: AI,
      };
      bank.world.assistant.conversations.push(c);
      say(c.id, 'assistant', [
        text(`Hi ${bank.user.preferred_name ?? bank.user.first_name}! What can I help with?`),
      ]);
      return c;
    },
    async listMessages({ path, query }) {
      conversation(path.conversation_id);
      const messages = bank.world.assistant.messages
        .filter((m) => m.conversationId === path.conversation_id)
        .map(({ conversationId: _c, ...m }) => m);
      return paginate(newestFirst(messages), query);
    },
    async sendMessage({ path, body }) {
      const c = conversation(path.conversation_id);
      if (!body.text.trim()) throw problem(422, 'validation_failed', 'Type a message');
      say(c.id, 'user', [text(body.text.trim())]);
      return say(c.id, 'assistant', await answer(body));
    },
    async confirmAction({ path, idempotencyKey }) {
      const a = action(path.action_id);
      if (a.status === 'confirmed') return a;
      if (a.status !== 'prepared')
        throw problem(409, 'invalid_state', `This action is ${a.status}`);
      const r = repos();
      try {
        if (a.kind === 'transfer') {
          const t = await r.transfers.create({
            body: a.details as Schema<'CreateTransferRequest'>,
            idempotencyKey,
          });
          a.result = { resource: 'transfer', id: t.id };
        } else if (a.kind === 'bill_payment') {
          const p = await r.bills.pay({
            body: a.details as Schema<'PayBillRequest'>,
            idempotencyKey,
          });
          a.result = { resource: 'bill_payment', id: p.id };
        } else if (a.kind === 'savings_deposit') {
          const goal =
            bank.world.goals.find((g) => a.summary.includes(g.name)) ?? bank.world.goals[0];
          if (!goal) throw notFound('Goal');
          await r.savings.deposit({
            path: { goal_id: goal.id },
            body: a.details as Schema<'SavingsMovementRequest'>,
            idempotencyKey,
          });
          a.result = { resource: 'savings_goal', id: goal.id };
        } else if (a.kind === 'fx_conversion') {
          const c = await r.fx.convert({
            body: a.details as Schema<'FxConversionRequest'>,
            idempotencyKey,
          });
          a.result = { resource: 'fx_conversion', id: c.id };
        } else {
          const { card_id } = a.details as { card_id: string };
          await r.cards.freeze({ path: { card_id } });
          a.result = { resource: 'card', id: card_id };
        }
        a.status = 'confirmed';
      } catch (error) {
        a.status = 'failed';
        throw error;
      }
      return a;
    },
    async discardAction({ path }) {
      const a = action(path.action_id);
      if (a.status === 'prepared') a.status = 'discarded';
      return a;
    },
  };
}
