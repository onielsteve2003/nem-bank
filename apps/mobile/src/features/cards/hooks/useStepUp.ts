import type { Schema } from '@nem/contracts';

import { getDeviceKeyInfo, signWithDeviceKey } from '@/lib/deviceKey';
import { useRepoMutation } from '@/lib/query';

/** What the customer gave the ConfirmSheet: their PIN, or Face ID / fingerprint. */
export type StepUpProof = { pin: string } | { biometric: string };

/** The customer cancelled the system prompt: stay on the pad, say nothing. */
export class StepUpCancelled extends Error {}

/** No device key to sign with, so Face ID can't stand in for the PIN here. */
export class StepUpNeedsPin extends Error {}

/**
 * A fresh bank check for one sensitive action: start a step-up for `purpose`,
 * then pass it with the PIN or a device-key signature over its ID. Returns the
 * single-use token for the protected call.
 */
export function useStepUp() {
  const start = useRepoMutation('auth', 'startStepUp', { invalidates: [] });
  const verify = useRepoMutation('auth', 'verifyStepUp', { invalidates: [] });

  return async (
    purpose: Schema<'StepUpPurpose'>,
    resourceId: string,
    proof: StepUpProof,
  ): Promise<string> => {
    const challenge = await start.mutateAsync({ body: { purpose, resource_id: resourceId } });
    let body: Schema<'StepUpVerifyRequest'>;
    if ('pin' in proof) {
      body = { pin: proof.pin };
    } else {
      if (!(await getDeviceKeyInfo())) throw new StepUpNeedsPin();
      try {
        body = { signature: await signWithDeviceKey(challenge.step_up_id, 'Confirm it’s you') };
      } catch {
        throw new StepUpCancelled();
      }
    }
    const { step_up_token } = await verify.mutateAsync({
      path: { step_up_id: challenge.step_up_id },
      body,
    });
    return step_up_token;
  };
}
