import type { Schema } from '@nem/contracts';

import { problem } from '../errors';
import { findCustomer } from './customers';
import type { Handlers } from './handlers';
import { paginate, staffRef } from './paging';
import { newId, type MockState } from './state';
import type { ConversationRecord } from './supportSeed';

function findChat(state: MockState, conversationId: string): ConversationRecord {
  const found = state.support.get(conversationId);
  if (!found) throw problem(404, 'not_found', 'No conversation with that ID');
  return found;
}

/** Minutes since the first customer message nobody has answered yet; 0 if none. */
function waitingMinutes(chat: ConversationRecord, now: number): number {
  if (chat.conversation.status === 'resolved') return 0;
  const lastReply = chat.messages.map((m) => m.sender).lastIndexOf('agent');
  const firstUnanswered = chat.messages.slice(lastReply + 1).find((m) => m.sender === 'customer');
  if (!firstUnanswered) return 0;
  return Math.max(0, Math.floor((now - Date.parse(firstUnanswered.created_at)) / 60_000));
}

function agentView(state: MockState, chat: ConversationRecord): Schema<'AgentConversation'> {
  return structuredClone({
    conversation: chat.conversation,
    customer: findCustomer(state, chat.customerId).view.customer,
    waiting_minutes: waitingMinutes(chat, state.now()),
  });
}

const firstName = (name: string) => name.split(' ')[0]!;

export const supportHandlers: Handlers = {
  listAgentConversations: ({ query } = {}, { state, staff }) => {
    const rows = [...state.support.values()]
      // No status means the chats still open on either side.
      .filter((c) =>
        query?.status
          ? c.conversation.status === query.status
          : c.conversation.status !== 'resolved',
      )
      .filter((c) => !query?.assigned_to_me || c.assigneeId === staff?.id)
      .map((c) => agentView(state, c))
      // Longest waiting first; then the most recent activity.
      .sort(
        (a, b) =>
          b.waiting_minutes - a.waiting_minutes ||
          b.conversation.last_message_at.localeCompare(a.conversation.last_message_at),
      );
    return paginate(rows, query?.cursor, query?.limit);
  },

  listAgentMessages: ({ path, query }, { state }) => {
    const chat = findChat(state, path.conversation_id);
    // An agent opening the chat reads the customer's messages, as the API will record.
    const at = new Date(state.now()).toISOString();
    for (const m of chat.messages) if (m.sender === 'customer' && !m.read_at) m.read_at = at;
    chat.conversation.unread_count = 0;
    const newestFirst = structuredClone(chat.messages).reverse();
    return paginate(newestFirst, query?.cursor, query?.limit ?? 50);
  },

  sendAgentMessage: ({ path, body }, { state, staff }) => {
    const chat = findChat(state, path.conversation_id);
    const me = staffRef(staff);
    const text = body.body.trim();
    if (text.length < 1 || text.length > 2000) {
      throw problem(422, 'validation_failed', 'A message needs 1 to 2,000 characters', {
        errors: [{ field: '/body', code: 'length', message: 'Use 1 to 2,000 characters.' }],
      });
    }
    if (chat.conversation.status === 'resolved') {
      throw problem(409, 'conflict', 'This chat is resolved. The customer can start a new one.');
    }
    // The first agent to reply takes the chat; a colleague can still help without taking it.
    if (!chat.assigneeId) {
      chat.assigneeId = me.id;
      chat.conversation.assigned_agent = firstName(me.name);
    }
    const at = new Date(state.now()).toISOString();
    const message: Schema<'SupportMessage'> = {
      id: newId(),
      conversation_id: chat.conversation.id,
      sender: 'agent',
      sender_name: firstName(me.name),
      body: text,
      attachments: [],
      created_at: at,
      read_at: null,
    };
    chat.messages.push(message);
    chat.conversation.status = 'waiting_on_customer';
    chat.conversation.last_message_at = at;
    return structuredClone(message);
  },

  resolveConversation: ({ path }, { state, staff }) => {
    const chat = findChat(state, path.conversation_id);
    const me = staffRef(staff);
    if (chat.conversation.status === 'resolved') {
      throw problem(409, 'conflict', 'This chat is already resolved');
    }
    const at = new Date(state.now()).toISOString();
    chat.messages.push({
      id: newId(),
      conversation_id: chat.conversation.id,
      sender: 'system',
      sender_name: null,
      body: `${firstName(me.name)} marked this chat resolved.`,
      attachments: [],
      created_at: at,
      read_at: at,
    });
    chat.conversation.status = 'resolved';
    chat.conversation.last_message_at = at;
    findCustomer(state, chat.customerId).view.open_cases.support -= 1;
    return agentView(state, chat);
  },
};
