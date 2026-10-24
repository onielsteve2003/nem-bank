import { Fingerprint, ScanFace } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BottomSheet, PinPad } from '@/components';
import { isApiError } from '@/data';
import { DEMO_PIN } from '@/data/mock';
import { pinErrorMessage } from '@/features/lock/pinErrors';
import { authenticateWithBiometrics, getBiometrics, NO_BIOMETRICS } from '@/lib/biometrics';
import { getDeviceKeyInfo } from '@/lib/deviceKey';
import { useRepoMutation } from '@/lib/query';
import { useSessionStore } from '@/stores';

interface Props {
  open: boolean;
  onClose: () => void;
  /** e.g. "Send ₦25,000.00 to Chidi". */
  subtitle: string;
  /**
   * Runs once the customer has proved it is them, with the PIN when that was the
   * proof (for a bank step-up). Resolve `false` (and set `error`) to keep the
   * sheet open on the pad.
   */
  onApproved: (pin?: string) => Promise<boolean>;
  /** Why the last attempt to send failed, shown under the pad. */
  error?: string;
  /**
   * Replaces the plain system prompt, for callers whose proof is itself
   * biometric-gated (signing a bank challenge with the device key prompts on
   * its own, so prompting first would ask twice).
   */
  approveWithBiometrics?: (label: string) => Promise<boolean>;
}

/**
 * The last step before money moves (TRF-5): the bank-checked transaction PIN, or
 * Face ID / fingerprint when this phone's key was set up with it. The transfer
 * itself is then signed with the device key by the transport.
 */
export function ConfirmSheet({
  open,
  onClose,
  subtitle,
  onApproved,
  error,
  approveWithBiometrics,
}: Props) {
  const isDemo = useSessionStore((s) => s.session?.isDemo ?? false);
  const verify = useRepoMutation('users', 'verifyPin', { invalidates: [] });
  const [biometrics, setBiometrics] = useState(NO_BIOMETRICS);
  const [pinError, setPinError] = useState<string>();
  const prompted = useRef(false);

  const tryBiometrics = useCallback(
    async (label: string) => {
      if (approveWithBiometrics) await approveWithBiometrics(label);
      else if (await authenticateWithBiometrics(`Approve with ${label}`)) await onApproved();
    },
    [onApproved, approveWithBiometrics],
  );

  useEffect(() => {
    if (!open) {
      prompted.current = false;
      return;
    }
    let cancelled = false;
    void Promise.all([getBiometrics(), getDeviceKeyInfo()]).then(([available, key]) => {
      if (cancelled) return;
      // A fresh look each time it opens: the last attempt's PIN error is gone.
      setPinError(undefined);
      // Turned down at sign-up (AUTH-5): PIN only.
      const found = key?.biometric === false ? NO_BIOMETRICS : available;
      setBiometrics(found);
      if (found.available && !prompted.current) {
        prompted.current = true;
        void tryBiometrics(found.label);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open, tryBiometrics]);

  const onComplete = async (pin: string) => {
    try {
      const result = await verify.mutateAsync({ body: { pin } });
      if (!result.valid) {
        setPinError(pinErrorMessage(result));
        return false;
      }
    } catch (e) {
      setPinError(
        isApiError(e) && e.problem.code === 'offline'
          ? "You're offline, so your PIN can't be checked. Reconnect and try again."
          : "We couldn't check your PIN. Try again.",
      );
      return false;
    }
    setPinError(undefined);
    return onApproved(pin);
  };

  return (
    <BottomSheet open={open} onClose={onClose} title="Confirm it's you">
      <View style={styles.pad}>
        <PinPad
          title="Enter your PIN"
          subtitle={isDemo ? `${subtitle}. Demo PIN is ${DEMO_PIN}` : subtitle}
          error={pinError ?? error}
          onComplete={onComplete}
          accessory={
            biometrics.available
              ? {
                  icon: biometrics.label === 'Face ID' ? ScanFace : Fingerprint,
                  accessibilityLabel: `Use ${biometrics.label}`,
                  onPress: () => void tryBiometrics(biometrics.label),
                }
              : undefined
          }
        />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  pad: { alignItems: 'center' },
});
