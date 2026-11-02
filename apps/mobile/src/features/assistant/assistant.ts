import type { Schema } from '@nem/contracts';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { isApiError } from '@/data';

// Nem Assistant (AI-6). The bank keeps the chat; this phone only remembers
// which conversation is open, so history is there when the assistant reopens.

export type AssistantMessage = Schema<'AssistantMessage'>;
export type AssistantBlock = Schema<'AssistantBlock'>;

export const PROMPT_MAX = 1000;

/** Starters shown before the first question; each is one the scripted bank understands. */
export const SUGGESTIONS = [
  "What's my balance?",
  'How much did I spend this month?',
  'Show my recent transactions',
  'Send ₦5,000 to @amaka_o',
  'Freeze my card',
];

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

export const PROBLEM_MESSAGE: Record<AssistantProblem, string> = {
  off: 'The assistant is off.',
  unavailable: "The assistant isn't available right now. These shortcuts still work.",
  busy: "You've asked a lot just now. Try again in a minute.",
  offline: "You're offline. Reconnect and try again.",
  gone: 'That chat has ended. Start a new one.',
  other: "That didn't go through. Try again.",
};

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
