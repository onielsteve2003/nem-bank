import type { Tone } from '@/components/Badge';

import type { AgentConversation } from './useSupport';

export const CHAT_STATUS: Readonly<
  Record<AgentConversation['conversation']['status'], [label: string, tone: Tone]>
> = {
  open: ['Needs reply', 'warning'],
  waiting_on_customer: ['Waiting on customer', 'neutral'],
  resolved: ['Resolved', 'success'],
};

/** "4 min", "2 h 10 min": how long the customer has been waiting for an answer. */
export function formatWait(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
