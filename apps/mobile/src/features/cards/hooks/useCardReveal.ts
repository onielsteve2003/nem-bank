import type { Schema } from '@nem/contracts';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { isApiError } from '@/data';
import { getDeviceKeyInfo, signWithDeviceKey } from '@/lib/deviceKey';
import { useRepoMutation } from '@/lib/query';

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
  unlock: (cardId: string, proof: { pin: string } | { biometric: string }) => Promise<boolean>;
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
  const start = useRepoMutation('auth', 'startStepUp', { invalidates: [] });
  const verify = useRepoMutation('auth', 'verifyStepUp', { invalidates: [] });
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
      const challenge = await start.mutateAsync({
        body: { purpose: 'card_reveal', resource_id: cardId },
      });
      let body: Schema<'StepUpVerifyRequest'>;
      if ('pin' in proof) {
        body = { pin: proof.pin };
      } else {
        if (!(await getDeviceKeyInfo())) {
          setError(`${proof.biometric} isn't set up for card details here. Enter your PIN.`);
          return false;
        }
        try {
          body = {
            signature: await signWithDeviceKey(challenge.step_up_id, 'Show card details'),
          };
        } catch {
          // Cancelled the system prompt: stay on the pad.
          return false;
        }
      }
      const { step_up_token } = await verify.mutateAsync({
        path: { step_up_id: challenge.step_up_id },
        body,
      });
      const secrets = await reveal.mutateAsync({
        path: { card_id: cardId },
        stepUpToken: step_up_token,
      });
      setSecondsLeft(REVEAL_SECONDS);
      setDetails(secrets);
      return true;
    } catch (e) {
      setError(failure(e));
      return false;
    }
  };

  return { details, secondsLeft, error, unlock, hide };
}
