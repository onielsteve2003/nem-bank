import type { Schema } from '@nem/contracts';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { isApiError } from '@/data';
import i18n, { localized } from '@/lib/i18n';

// Nem Assistant (AI-6). The bank keeps the chat; this phone only remembers
// which conversation is open, so history is there when the assistant reopens.

export type AssistantMessage = Schema<'AssistantMessage'>;
export type AssistantBlock = Schema<'AssistantBlock'>;

export const PROMPT_MAX = 1000;

/** Starters shown before the first question; each is one the scripted bank understands. */
export const suggestions = (): readonly string[] =>
  i18n.t('assistant.suggestions', { returnObjects: true });

export interface AssistantState {
  conversationId: string | null;
  setConversationId: (id: string | null) => void;
}

export const useAssistantStore = create<AssistantState>()(
  persist(
    (set) => ({
      conversationId: null,
      setConversationId: (conversationId) => set({ conversationId }),
    }),
    {
      name: 'nem-assistant',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ conversationId: s.conversationId }),
    },
  ),
);

/**
 * Why the assistant cannot answer. `off`: the customer turned it off.
 * `unavailable`: the model is down, so the non-AI shortcuts take over.
 */
export type AssistantProblem = 'off' | 'unavailable' | 'busy' | 'offline' | 'gone' | 'other';

export function assistantProblem(e: unknown): AssistantProblem {
  if (!isApiError(e)) return 'other';
  const { code, status } = e.problem;
  if (code === 'offline') return 'offline';
  if (code === 'feature_disabled' || status === 403) return 'off';
  if (code === 'assistant_unavailable' || status === 503) return 'unavailable';
  if (status === 429) return 'busy';
  if (status === 404) return 'gone';
  return 'other';
}

export const PROBLEM_MESSAGE = localized<AssistantProblem>({
  off: 'assistant.problems.off',
  unavailable: 'assistant.problems.unavailable',
  busy: 'assistant.problems.busy',
  offline: 'assistant.problems.offline',
  gone: 'assistant.problems.gone',
  other: 'assistant.problems.other',
});

/** The words of a reply, for streaming and for screen readers. */
export const replyText = (m: AssistantMessage) =>
  m.blocks
    .filter((b): b is Schema<'AssistantTextBlock'> => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');

/**
 * How much of a reply shows after `elapsedMs`: whole words at a reading pace,
 * so a word never appears half typed. The full text once time runs out.
 */
export function revealed(text: string, elapsedMs: number, msPerWord = 45): string {
  const words = text.split(/(\s+)/);
  const shown = Math.floor(elapsedMs / msPerWord) + 1;
  // Separators count as tokens: n words end at token 2n - 1.
  const end = shown * 2 - 1;
  return end >= words.length ? text : words.slice(0, end).join('');
}

export type PreparedAction = Schema<'PreparedAction'>;
export type ActionStatus = PreparedAction['status'];

/** A prepared action past its time is expired, even before the bank says so. */
export const actionStatus = (a: PreparedAction, now: Date = new Date()): ActionStatus =>
  a.status === 'prepared' && new Date(a.expires_at) <= now ? 'expired' : a.status;

/** "Expires in 4 min" while it can still be confirmed. */
export function expiresIn(a: PreparedAction, now: Date = new Date()): string {
  const minutes = Math.ceil((new Date(a.expires_at).getTime() - now.getTime()) / 60_000);
  return minutes <= 1
    ? i18n.t('assistant.expiresSoon')
    : i18n.t('assistant.expiresIn', { count: minutes });
}

/** What the card says once the action is no longer waiting. */
export const STATUS_LINE = localized<Exclude<ActionStatus, 'prepared'>>({
  confirmed: 'assistant.statusLine.confirmed',
  discarded: 'assistant.statusLine.discarded',
  expired: 'assistant.statusLine.expired',
  failed: 'assistant.statusLine.failed',
});

/** Where to see what a confirmed action made. */
export function resultRoute(result: NonNullable<PreparedAction['result']>) {
  switch (result.resource) {
    case 'transfer':
      return { pathname: '/send/result/[id]', params: { id: result.id } } as const;
    case 'bill_payment':
      return { pathname: '/bills/receipt/[id]', params: { id: result.id } } as const;
    case 'savings_goal':
      return { pathname: '/goals/[id]', params: { id: result.id } } as const;
    case 'card':
      return { pathname: '/cards', params: { card: result.id } } as const;
    case 'fx_conversion':
      return { pathname: '/convert/history' } as const;
  }
}

/**
 * Why confirming failed. A 409 means the action is no longer waiting (it
 * expired or was used elsewhere); anything else reads like a normal send error.
 */
export const isStaleAction = (e: unknown) => isApiError(e) && e.problem.status === 409;
