import type { Schema } from '@nem/contracts';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { isApiError } from '@/data';
import { useRepoMutation } from '@/lib/query';

import { StepUpCancelled, StepUpNeedsPin, useStepUp, type StepUpProof } from './useStepUp';

/** How long card details stay on screen once unlocked (CARD-3). */
export const REVEAL_SECONDS = 30;

type Revealed = Schema<'CardSecrets'>;

export type CardReveal = {
  /** The unlocked details, only for the card they belong to. */
  details: Revealed | null;
  secondsLeft: number;
  /** Why the last attempt failed, for the PIN sheet. */
  error: string | undefined;
  /** Proves it is the customer with the bank, then fetches the details. */
  unlock: (cardId: string, proof: StepUpProof) => Promise<boolean>;
  hide: () => void;
};

const failure = (e: unknown) => {
  if (isApiError(e)) {
    if (e.problem.code === 'offline') return "You're offline. Reconnect to see card details.";
    if (e.problem.code === 'invalid_state') return 'This card is closed, so its details are gone.';
    return e.problem.detail ?? e.problem.title;
  }
  return "We couldn't show the details. Try again.";
};

/**
 * Card details behind a fresh bank check (CARD-3): a `card_reveal` step-up passed
 * with the PIN or a device-key signature, then one reveal call. The details live
 * only in memory and go after 30 s, or as soon as the app leaves the screen.
 */
export function useCardReveal(): CardReveal {
  const stepUp = useStepUp();
  const reveal = useRepoMutation('cards', 'reveal', { invalidates: [] });
  const [details, setDetails] = useState<Revealed | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [error, setError] = useState<string>();

  const hide = useCallback(() => {
    setDetails(null);
    setSecondsLeft(0);
  }, []);

  // Counted on this phone's clock: the bank's `visible_until` follows its own
  // (simulated) clock, which Demo Controls can move.
  useEffect(() => {
    if (!details) return;
    const shownAt = Date.now();
    const timer = setInterval(() => {
      const left = REVEAL_SECONDS - Math.floor((Date.now() - shownAt) / 1000);
      if (left <= 0) hide();
      else setSecondsLeft(left);
    }, 250);
    return () => clearInterval(timer);
  }, [details, hide]);

  useEffect(() => {
    if (!details) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') hide();
    });
    return () => sub.remove();
  }, [details, hide]);

  const unlock: CardReveal['unlock'] = async (cardId, proof) => {
    setError(undefined);
    try {
      const token = await stepUp('card_reveal', cardId, proof);
      const secrets = await reveal.mutateAsync({
        path: { card_id: cardId },
        stepUpToken: token,
      });
      setSecondsLeft(REVEAL_SECONDS);
      setDetails(secrets);
      return true;
    } catch (e) {
      if (e instanceof StepUpCancelled) return false;
      if (e instanceof StepUpNeedsPin) {
        setError('Face ID isn’t set up for this here. Enter your PIN.');
        return false;
      }
      setError(failure(e));
      return false;
    }
  };

  return { details, secondsLeft, error, unlock, hide };
}
