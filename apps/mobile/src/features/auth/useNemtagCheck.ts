import { nemtagProblem, normalizeNemtag } from '@nem/shared';

import type { TextColor } from '@/components';
import { useRepoQuery } from '@/lib/query';
import { useDebounced } from '@/lib/useDebounced';

/** Waits for typing to pause, so the bank is asked once per pause, not per key. */
export const NEMTAG_CHECK_DELAY_MS = 400;

export type NemtagStatus = {
  tone: Extract<TextColor, 'danger' | 'success' | 'textMuted'>;
  text: string;
};

/**
 * A @nemtag as it is typed: shape rules at once, availability from the bank
 * once typing pauses, and ideas when it is taken. `current` is the tag you
 * already have, which is never "available" to you again.
 */
export function useNemtagCheck(input: string, current?: string | null) {
  const tag = normalizeNemtag(input);
  const shape = tag ? nemtagProblem(tag) : null;
  const settled = useDebounced(tag, NEMTAG_CHECK_DELAY_MS);
  const yours = tag !== '' && tag === current;
  const ready = tag !== '' && shape === null && !yours;

  const availability = useRepoQuery(
    'users',
    'checkNemtag',
    { path: { nemtag: settled } },
    { enabled: ready && settled === tag, staleTime: 10_000 },
  );

  const result = ready && settled === tag ? availability.data : undefined;
  const checking = ready && (settled !== tag || availability.isFetching);
  const available = Boolean(result?.nemtag === tag && result.available);
  const suggestions = result && !result.available ? result.suggestions.slice(0, 3) : [];

  const status = ((): NemtagStatus | null => {
    if (!tag) return null;
    if (shape) return { tone: 'danger', text: shape };
    if (yours) return { tone: 'textMuted', text: `@${tag} is your @nemtag now` };
    if (checking) return { tone: 'textMuted', text: `Checking @${tag}…` };
    if (availability.isError)
      return { tone: 'danger', text: "We couldn't check right now. Try again." };
    if (available) return { tone: 'success', text: `@${tag} is yours if you want it` };
    if (result) return { tone: 'danger', text: `@${tag} is taken` };
    return null;
  })();

  return { tag, available, checking, suggestions, status };
}
