import type { Schema } from '@nem/contracts';
import { useEffect, useState } from 'react';

import { useRealtime } from '@/data';
import i18n, { withLabel } from '@/lib/i18n';

export type ConversationStatus = Schema<'SupportConversation'>['status'];

export const CONVERSATION_STATUS: Record<
  ConversationStatus,
  { label: string; tone: 'info' | 'success' | 'neutral' }
> = {
  open: withLabel('support.status.open', { tone: 'info' }),
  waiting_on_customer: withLabel('support.status.waiting_on_customer', { tone: 'success' }),
  resolved: withLabel('support.status.resolved', { tone: 'neutral' }),
};

/** Quick subjects for a new chat; `other` lets you write your own. Words in support.topics. */
export const TOPICS = ['transfer', 'card', 'verification', 'bills', 'account', 'other'] as const;
export type Topic = (typeof TOPICS)[number];

export const SUBJECT_MAX = 80;
export const MESSAGE_MAX = 2000;
export const MAX_ATTACHMENTS = 5;

/**
 * What gets sent: your words, or a line naming the photos when you only send
 * photos (a message always needs a body).
 */
export function messageBody(text: string, photos: number): string {
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  if (photos === 0) return '';
  return i18n.t('support.sentPhotos', { count: photos });
}

/** A typing event that is never followed by a reply stops showing after this. */
const TYPING_TIMEOUT_MS = 15_000;

/** Whether the agent is typing in this conversation, from realtime events (SUP-1). */
export function useAgentTyping(conversationId: string): boolean {
  const realtime = useRealtime();
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const set = (next: boolean) => {
      clearTimeout(timer);
      setTyping(next);
      if (next) timer = setTimeout(() => setTyping(false), TYPING_TIMEOUT_MS);
    };
    const stop = realtime.subscribe((event) => {
      if (event.type === 'support.typing') {
        const { conversation_id, sender, typing: on } = event.data;
        if (conversation_id === conversationId && sender === 'agent') set(on);
      } else if (event.type === 'support.message') {
        if (event.data.conversation_id === conversationId && event.data.sender !== 'customer')
          set(false);
      }
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [realtime, conversationId]);

  return typing;
}
