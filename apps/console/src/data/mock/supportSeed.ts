import type { Schema } from '@nem/contracts';

import { customerId, type CustomerRecord } from './customerSeed';

// Customer chats waiting in the support inbox. Times are relative to "now" so the
// waiting clock reads like a live queue whenever the demo is opened.

type Message = Schema<'SupportMessage'>;

export interface ConversationRecord {
  conversation: Schema<'SupportConversation'>;
  customerId: string;
  /** Staff ID of the assigned agent; the contract only shows their first name. */
  assigneeId: string | null;
  /** Oldest first. */
  messages: Message[];
}

export const conversationId = (n: number) =>
  `01900000-0000-7000-8000-0000000b${String(n).padStart(4, '0')}`;
const messageId = (n: number, i: number) =>
  `01900000-0000-7000-8000-0000001b${n}${String(i).padStart(2, '0')}`.padEnd(36, '0');

const CHIDI = { id: '01900000-0000-7000-8000-00000000a004', name: 'Chidi' };
const IFEOMA = { id: '01900000-0000-7000-8000-00000000a001', name: 'Ifeoma' };

type Line = [sender: Message['sender'], minutesAgo: number, body: string, file?: string];

interface Spec {
  customer: number;
  subject: string;
  status: Schema<'SupportConversation'>['status'];
  agent?: { id: string; name: string };
  lines: Line[];
}

const SPECS: Spec[] = [
  {
    customer: 2,
    subject: 'My transfer is on hold',
    status: 'open',
    lines: [
      ['system', 31, 'Chat started from Help → Talk to us.'],
      ['customer', 31, 'Good afternoon. My transfer of ₦1.85m says "held for your safety". Why?'],
      ['customer', 24, 'Please it is urgent, the person is waiting for the money.'],
    ],
  },
  {
    customer: 7,
    subject: 'Card declined at Shoprite',
    status: 'open',
    agent: CHIDI,
    lines: [
      [
        'customer',
        52,
        'My virtual card was declined at Shoprite Lekki. I have money in the account.',
      ],
      [
        'agent',
        45,
        'Sorry about that. Virtual cards work online only. For a till, use your physical card or pay by transfer.',
      ],
      ['customer', 9, 'Ah ok. How do I order the physical card?'],
    ],
  },
  {
    customer: 6,
    subject: 'How do I raise my limit?',
    status: 'waiting_on_customer',
    agent: CHIDI,
    lines: [
      ['customer', 190, 'I want to send ₦600,000 but it says over my daily limit.'],
      [
        'agent',
        176,
        'Your Tier 2 daily limit is ₦500,000. Upgrade to Tier 3 from Me → Verification and it rises to ₦5m.',
      ],
    ],
  },
  {
    customer: 12,
    subject: 'Not getting my OTP',
    status: 'open',
    lines: [
      [
        'customer',
        4,
        'I am not receiving the email code to sign in on my new phone.',
        'otp-screen.png',
      ],
    ],
  },
  {
    customer: 3,
    subject: 'Transfer failed but I was debited',
    status: 'open',
    agent: IFEOMA,
    lines: [
      ['customer', 140, 'The transfer to GTBank failed but ₦120,000 left my account.'],
      [
        'agent',
        128,
        'I’ve raised dispute DSP-20261002 for you. Failed transfers usually reverse within 24 hours.',
      ],
      ['customer', 17, 'It is now more than 24 hours. Any update?'],
    ],
  },
  {
    customer: 1,
    subject: 'Statement for visa application',
    status: 'resolved',
    agent: CHIDI,
    lines: [
      ['customer', 2_900, 'I need a stamped statement for my UK visa.'],
      [
        'agent',
        2_880,
        'Go to Accounts → Statements, pick 6 months and download. It carries a QR code the embassy can verify.',
      ],
      ['customer', 2_875, 'Got it, thank you!'],
      ['system', 2_870, 'Chidi marked this chat resolved.'],
    ],
  },
];

function screenshot(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 540" width="300" height="540"><rect width="300" height="540" rx="28" fill="#f3f4f6"/><text x="150" y="220" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#4a5160">Enter the 6-digit code</text><g fill="#d5d9df"><rect x="45" y="250" width="30" height="40" rx="6"/><rect x="85" y="250" width="30" height="40" rx="6"/><rect x="125" y="250" width="30" height="40" rx="6"/><rect x="165" y="250" width="30" height="40" rx="6"/><rect x="205" y="250" width="30" height="40" rx="6"/></g><text x="150" y="500" text-anchor="middle" font-family="sans-serif" font-size="16" font-weight="700" fill="#b4232a" opacity="0.7">SAMPLE SCREENSHOT</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function build(spec: Spec, n: number, record: CustomerRecord, now: number): ConversationRecord {
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const firstName = record.view.customer.name.split(' ')[0]!;
  const messages = spec.lines.map(([sender, minutesAgo, body, file], i): Message => {
    const created = at(minutesAgo);
    const answered = spec.lines.slice(i + 1).some(([s]) => s === 'agent');
    return {
      id: messageId(n, i),
      conversation_id: conversationId(n),
      sender,
      sender_name: sender === 'agent' ? spec.agent!.name : sender === 'customer' ? firstName : null,
      body,
      attachments: file
        ? [
            {
              id: messageId(n, 90 + i),
              file_name: file,
              content_type: 'image/png',
              size_bytes: 96_000,
              url: screenshot(),
              uploaded_at: created,
            },
          ]
        : [],
      created_at: created,
      // A customer message counts as read once an agent has answered after it.
      read_at: sender !== 'customer' || answered || spec.status === 'resolved' ? created : null,
    };
  });
  const last = messages.at(-1)!;
  return {
    customerId: record.view.customer.user_id,
    assigneeId: spec.agent?.id ?? null,
    messages,
    conversation: {
      id: conversationId(n),
      subject: spec.subject,
      status: spec.status,
      assigned_agent: spec.agent?.name ?? null,
      unread_count: messages.filter((m) => m.sender === 'customer' && !m.read_at).length,
      last_message_at: last.created_at,
      created_at: messages[0]!.created_at,
    },
  };
}

/** Builds the inbox and recounts each customer's open chats on their 360. */
export function seedSupport(
  customers: Map<string, CustomerRecord>,
  now: number,
): Map<string, ConversationRecord> {
  for (const record of customers.values()) record.view.open_cases.support = 0;
  const chats = SPECS.map((spec, i) => {
    const record = customers.get(customerId(spec.customer))!;
    if (spec.status !== 'resolved') record.view.open_cases.support += 1;
    return build(spec, i + 1, record, now);
  });
  return new Map(chats.map((c) => [c.conversation.id, c]));
}
