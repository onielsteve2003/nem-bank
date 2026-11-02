import type { Schema } from '@nem/contracts';
import { negate } from '@nem/shared';

import { problem } from '../../errors';
import type { DisputesRepo, NotificationsRepo, SupportRepo } from '../../repositories';
import { fromApi, newestFirst, notFound, paginate } from '../convert';
import type { MockBank } from '../runtime';
import { customerTransactions } from '../views';

// Disputes, support chat and the notification inbox (DSP, SUP, NOT).

const UNDER_REVIEW_MS = 20_000;
const AUTO_REFUND_MS = 60_000;
const AGENT_REPLY_MS = 5_000;
/** The agent starts typing a little after your message lands, then replies. */
const AGENT_TYPING_MS = 1_500;
const AGENT = 'Ada (Nem Support)';
/** Reasons the sandbox can settle without a person: the ledger shows the answer. */
const AUTO_REFUND: ReadonlySet<Schema<'DisputeReason'>> = new Set([
  'failed_but_debited',
  'duplicate_charge',
]);

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export function attachmentFrom(bank: MockBank, upload: Schema<'FileUpload'>): Schema<'Attachment'> {
  const match = /^data:(image\/jpeg|image\/png|application\/pdf);base64,(.*)$/s.exec(upload.file);
  if (!match) throw problem(415, 'unsupported_media_type', 'Upload a JPEG, PNG or PDF');
  const size = Math.floor((match[2]!.length * 3) / 4);
  if (size > MAX_UPLOAD_BYTES) throw problem(413, 'payload_too_large', 'Files can be up to 5 MB');
  const type = match[1] as Schema<'Attachment'>['content_type'];
  const attachment: Schema<'Attachment'> = {
    id: bank.id(),
    file_name:
      upload.caption?.trim() || `upload.${type === 'application/pdf' ? 'pdf' : type.split('/')[1]}`,
    content_type: type,
    size_bytes: size,
    url: upload.file,
    uploaded_at: bank.nowIso(),
  };
  bank.world.attachments.push(attachment);
  return attachment;
}

function step(
  bank: MockBank,
  dispute: Schema<'Dispute'>,
  status: Schema<'DisputeStatus'>,
  label: string,
  detail?: string,
) {
  dispute.status = status;
  dispute.timeline.push({ status, label, at: bank.nowIso(), detail: detail ?? null });
}

export function processDisputes(bank: MockBank): boolean {
  const now = bank.now().getTime();
  let changed = false;
  for (const d of bank.world.disputes) {
    const age = now - Date.parse(d.created_at);
    if (d.status === 'submitted' && age >= UNDER_REVIEW_MS) {
      step(bank, d, 'under_review', 'A specialist is looking at it');
      changed = true;
    }
    if (d.status === 'under_review' && AUTO_REFUND.has(d.reason) && age >= AUTO_REFUND_MS) {
      const txn = customerTransactions(bank).find((t) => t.id === d.transaction_id);
      if (!txn) continue;
      const amount = fromApi(txn.amount);
      bank.ledger.post({
        kind: 'dispute_refund',
        reference: d.case_number,
        idempotencyKey: `dispute:${d.id}`,
        postings: [
          {
            accountId: bank.ledger.systemAccount('suspense', amount.currency).id,
            amount: negate(amount),
          },
          { accountId: txn.account_id, amount },
        ],
        metadata: {
          txns: [
            {
              id: bank.id(),
              accountId: txn.account_id,
              direction: 'credit',
              type: 'dispute_refund',
              category: txn.category,
              narration: `Refund: ${txn.narration}`,
              counterparty: txn.counterparty,
            },
          ],
        },
      });
      d.refund = txn.amount;
      d.resolution_note =
        'We confirmed the charge should not have happened and refunded you in full.';
      d.resolved_at = bank.nowIso();
      step(bank, d, 'resolved_refunded', 'Refunded');
      bank.notify({
        category: 'transactions',
        title: `Dispute ${d.case_number} refunded`,
        body: 'The money is back in your account.',
        deep_link: `nembank://disputes/${d.id}`,
      });
      changed = true;
    }
  }
  return changed;
}

const REPLIES: [RegExp, string][] = [
  [
    /transfer|sent|debit|money/i,
    'Thanks for the details. I can see the transaction on our side and I am checking it with the partner bank now.',
  ],
  [
    /card/i,
    'If your card is lost or you see a charge you do not know, freeze it from the Cards tab first. I am looking into it.',
  ],
  [
    /kyc|verify|tier|id\b/i,
    'Verification usually takes a few minutes in the demo. I will keep an eye on your submission.',
  ],
];

/**
 * The sandbox agent: starts typing a moment after your message lands, then
 * replies. Typing is stored so it changes between ticks and becomes an event.
 */
export function processSupport(bank: MockBank): boolean {
  const now = bank.now().getTime();
  const replyBy = new Date(now - AGENT_REPLY_MS).toISOString();
  const typeBy = new Date(now - AGENT_TYPING_MS).toISOString();
  const typing = new Set(bank.world.supportTyping);
  let changed = false;
  for (const c of bank.world.conversations) {
    if (c.status === 'resolved') continue;
    const last = bank.world.messages.filter((m) => m.conversation_id === c.id).at(-1);
    if (!last || last.sender !== 'customer' || last.created_at > typeBy) continue;
    if (last.created_at > replyBy) {
      if (!typing.has(c.id)) {
        typing.add(c.id);
        changed = true;
      }
      continue;
    }
    typing.delete(c.id);
    const reply =
      REPLIES.find(([pattern]) => pattern.test(last.body))?.[1] ??
      'Thanks for reaching out. How can I help further?';
    bank.world.messages.push({
      id: bank.id(),
      conversation_id: c.id,
      sender: 'agent',
      sender_name: AGENT,
      body: reply,
      attachments: [],
      created_at: bank.nowIso(),
      read_at: null,
    });
    c.assigned_agent = AGENT;
    c.status = 'waiting_on_customer';
    c.unread_count += 1;
    c.last_message_at = bank.nowIso();
    changed = true;
  }
  bank.world.supportTyping = [...typing];
  return changed;
}

const ARTICLES: Schema<'HelpArticle'>[] = [
  {
    slug: 'transfer-pending',
    title: 'My transfer is pending',
    category: 'Transfers',
    body_markdown:
      'Transfers to other banks usually arrive in seconds. If one fails, the money comes back to you automatically and we tell you.',
    updated_at: '2026-10-01T09:00:00Z',
  },
  {
    slug: 'cooling-off',
    title: 'Why did my transfer to a new beneficiary wait 30 minutes?',
    category: 'Security',
    body_markdown:
      'The first payment above ₦100,000 to someone new waits 30 minutes, or goes now if you confirm with your PIN or OTP. It stops most "send it now" scams.',
    updated_at: '2026-10-01T09:00:00Z',
  },
  {
    slug: 'panic-button',
    title: 'Using the panic button',
    category: 'Security',
    body_markdown:
      'Panic mode freezes every card and blocks money leaving your account in one tap. Releasing it needs a step-up check.',
    updated_at: '2026-10-01T09:00:00Z',
  },
  {
    slug: 'kyc-tiers',
    title: 'KYC tiers and limits',
    category: 'Account',
    body_markdown:
      'Tier 1: ₦50,000 a day. Tier 2 (BVN or NIN): ₦200,000. Tier 3 (ID, selfie, address): ₦5,000,000. These are demo values.',
    updated_at: '2026-10-01T09:00:00Z',
  },
  {
    slug: 'emtl',
    title: 'What is the ₦50 EMTL charge?',
    category: 'Fees',
    body_markdown:
      'The Electronic Money Transfer Levy is a ₦50 government levy on transfers into your account of ₦10,000 or more.',
    updated_at: '2026-10-01T09:00:00Z',
  },
  {
    slug: 'ajo',
    title: 'How ajo works on Nem',
    category: 'Savings',
    body_markdown:
      'Everyone pays the same amount each cycle into a protected pot, and one member takes the whole pot in turn.',
    updated_at: '2026-10-01T09:00:00Z',
  },
  {
    slug: 'freeze-card',
    title: 'Freeze or replace a lost card',
    category: 'Cards',
    body_markdown:
      'Open the card in the Cards tab and tap Freeze. Nothing can be charged until you unfreeze it.\n\nIf the card is gone for good, freeze it, then create a new virtual card. Your old card number stops working.',
    updated_at: '2026-10-01T09:00:00Z',
  },
  {
    slug: 'convert-currency',
    title: 'Converting naira to dollars, pounds or euros',
    category: 'FX',
    body_markdown:
      'Open Convert, choose the currencies and the amount. The rate is locked for 60 seconds while you confirm.\n\nThe rate you see is the rate you get: there is no hidden markup on top.',
    updated_at: '2026-10-01T09:00:00Z',
  },
  {
    slug: 'report-a-problem',
    title: 'Reporting a problem with a payment',
    category: 'Disputes',
    body_markdown:
      'Open the payment from your transactions and tap Report a problem. Tell us what went wrong and add photos if you have them.\n\nYou get a case number straight away and can follow it in Me > Disputes. If you were charged for a failed payment or charged twice, we usually refund you within a day.',
    updated_at: '2026-10-01T09:00:00Z',
  },
  {
    slug: 'statements',
    title: 'Getting a bank statement for a visa or loan',
    category: 'Account',
    body_markdown:
      'Go to Me > Statements and pick the dates. Every statement has a verification code and QR, so an embassy or lender can check it is real.',
    updated_at: '2026-10-01T09:00:00Z',
  },
  {
    slug: 'never-share-pin',
    title: 'Someone asked for my PIN or a code',
    category: 'Security',
    body_markdown:
      'Nem staff will never ask for your PIN, password or a one-time code, by phone, chat or email.\n\nIf someone does, stop talking to them, turn on the panic button if you shared anything, and chat with us from Me > Help and support.',
    updated_at: '2026-10-01T09:00:00Z',
  },
  {
    slug: 'bills-failed',
    title: 'My airtime or electricity token did not arrive',
    category: 'Bills',
    body_markdown:
      'Most bills complete in seconds. If the biller fails, the money comes back to you automatically.\n\nFor electricity, the token is on the receipt in your transactions. If it still has not arrived after 15 minutes, report a problem on the payment.',
    updated_at: '2026-10-01T09:00:00Z',
  },
];

/** The first paragraph, cut at a word if it runs long. */
function excerpt(body: string): string {
  const first = body.split('\n\n')[0] ?? '';
  return first.length > 120 ? `${first.slice(0, first.lastIndexOf(' ', 117))}…` : first;
}

/** Every word must appear; title matches come first. */
function searchHelp(q: string, category?: string): Schema<'HelpArticle'>[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const inCategory = ARTICLES.filter(
    (a) => !category || a.category.toLowerCase() === category.toLowerCase(),
  );
  if (!words.length) return inCategory;
  const scored = inCategory.flatMap((a) => {
    const title = a.title.toLowerCase();
    const text = `${title} ${a.category} ${a.body_markdown}`.toLowerCase();
    if (!words.every((w) => text.includes(w))) return [];
    return [{ a, score: words.filter((w) => title.includes(w)).length }];
  });
  return scored.sort((x, y) => y.score - x.score).map((x) => x.a);
}

export function disputesRepo(bank: MockBank): DisputesRepo {
  const find = (id: string) => {
    const d = bank.world.disputes.find((x) => x.id === id);
    if (!d) throw notFound('Dispute');
    return d;
  };
  return {
    async list({ query } = {}) {
      return paginate(newestFirst(bank.world.disputes), query);
    },
    async create({ body }) {
      const txn = customerTransactions(bank).find((t) => t.id === body.transaction_id);
      if (!txn) throw notFound('Transaction');
      if (txn.direction !== 'debit' || txn.status !== 'completed') {
        throw problem(
          422,
          'validation_failed',
          'Only completed payments out of your account can be disputed',
        );
      }
      if (
        bank.world.disputes.some((d) => d.transaction_id === txn.id && d.status !== 'withdrawn')
      ) {
        throw problem(409, 'dispute_exists', 'This transaction already has a dispute');
      }
      if (body.description.trim().length < 10)
        throw problem(422, 'validation_failed', 'Tell us a little more (10 characters or more)');
      bank.world.sequence += 1;
      const dispute: Schema<'Dispute'> = {
        id: bank.id(),
        case_number: `DSP-${bank.world.sequence.toString().padStart(8, '0')}`,
        transaction_id: txn.id,
        reason: body.reason,
        description: body.description.trim(),
        status: 'submitted',
        timeline: [
          { status: 'submitted', label: 'Dispute received', at: bank.nowIso(), detail: null },
        ],
        evidence: (body.attachment_ids ?? []).map((id) => {
          const a = bank.world.attachments.find((x) => x.id === id);
          if (!a) throw notFound('Attachment');
          return a;
        }),
        refund: null,
        resolution_note: null,
        created_at: bank.nowIso(),
        resolved_at: null,
      };
      bank.world.disputes.push(dispute);
      return dispute;
    },
    async get({ path }) {
      return find(path.dispute_id);
    },
    async addEvidence({ path, body }) {
      const d = find(path.dispute_id);
      if (d.resolved_at || d.status === 'withdrawn')
        throw problem(409, 'invalid_state', 'This dispute is closed');
      d.evidence.push(attachmentFrom(bank, body));
      if (d.status === 'awaiting_customer')
        step(bank, d, 'under_review', 'Thanks, we have your evidence');
      return d;
    },
    async withdraw({ path }) {
      const d = find(path.dispute_id);
      if (d.resolved_at) throw problem(409, 'invalid_state', 'This dispute is already resolved');
      if (d.status !== 'withdrawn') step(bank, d, 'withdrawn', 'Withdrawn by you');
      return d;
    },
  };
}

export function supportRepo(bank: MockBank): SupportRepo {
  const find = (id: string) => {
    const c = bank.world.conversations.find((x) => x.id === id);
    if (!c) throw notFound('Conversation');
    return c;
  };
  const post = (conversationId: string, body: string, attachmentIds: string[] = []) => {
    const attachments = attachmentIds.map((id) => {
      const a = bank.world.attachments.find((x) => x.id === id);
      if (!a) throw notFound('Attachment');
      return a;
    });
    const message: Schema<'SupportMessage'> = {
      id: bank.id(),
      conversation_id: conversationId,
      sender: 'customer',
      sender_name: null,
      body: body.trim(),
      attachments,
      created_at: bank.nowIso(),
      read_at: null,
    };
    if (!message.body && attachments.length === 0)
      throw problem(422, 'validation_failed', 'Write a message');
    bank.world.messages.push(message);
    return message;
  };
  return {
    async listConversations() {
      return {
        data: [...bank.world.conversations].sort((a, b) =>
          b.last_message_at.localeCompare(a.last_message_at),
        ),
      };
    },
    async startConversation({ body }) {
      const conversation: Schema<'SupportConversation'> = {
        id: bank.id(),
        subject: body.subject.trim(),
        status: 'open',
        assigned_agent: null,
        unread_count: 0,
        last_message_at: bank.nowIso(),
        created_at: bank.nowIso(),
      };
      bank.world.conversations.push(conversation);
      const ref = body.transaction_id ? `\n\n(About transaction ${body.transaction_id})` : '';
      post(conversation.id, `${body.message}${ref}`);
      return conversation;
    },
    async getConversation({ path }) {
      return find(path.conversation_id);
    },
    async listMessages({ path, query }) {
      const c = find(path.conversation_id);
      const messages = bank.world.messages.filter((m) => m.conversation_id === c.id);
      // Opening the thread reads it.
      for (const m of messages)
        if (m.sender !== 'customer' && !m.read_at) m.read_at = bank.nowIso();
      c.unread_count = 0;
      return paginate(newestFirst(messages), query);
    },
    async sendMessage({ path, body }) {
      const c = find(path.conversation_id);
      const message = post(c.id, body.body, body.attachment_ids);
      c.status = 'open';
      c.last_message_at = message.created_at;
      return message;
    },
    async uploadAttachment({ body }) {
      return attachmentFrom(bank, body);
    },
    async searchArticles({ query } = {}) {
      return {
        data: searchHelp(query?.q ?? '', query?.category).map((a) => ({
          slug: a.slug,
          title: a.title,
          category: a.category,
          excerpt: excerpt(a.body_markdown),
        })),
      };
    },
    async getArticle({ path }) {
      const article = ARTICLES.find((a) => a.slug === path.slug);
      if (!article) throw notFound('Article');
      return article;
    },
  };
}

export function notificationsRepo(bank: MockBank): NotificationsRepo {
  return {
    async list({ query } = {}) {
      const all = newestFirst(bank.world.notifications);
      const page = paginate(query?.unread_only ? all.filter((n) => !n.read) : all, query);
      return { ...page, unread_count: all.filter((n) => !n.read).length };
    },
    async markRead({ body }) {
      const ids = new Set(body.ids ?? []);
      for (const n of bank.world.notifications) if (body.all || ids.has(n.id)) n.read = true;
    },
    async getPreferences() {
      return bank.world.notificationPreferences;
    },
    async setPreferences({ body }) {
      // Security alerts always reach the inbox; only their push and email can be turned off.
      body.categories.security.in_app = true;
      bank.world.notificationPreferences = body;
      return body;
    },
    async registerPushToken({ body }) {
      if (!bank.world.devices.some((d) => d.id === body.device_id)) throw notFound('Device');
      bank.world.pushTokens[body.device_id] = body.expo_push_token;
    },
    async unregisterPushToken({ path }) {
      delete bank.world.pushTokens[path.device_id];
    },
  };
}
