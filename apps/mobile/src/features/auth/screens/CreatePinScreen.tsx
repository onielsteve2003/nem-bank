import { isDateOfBirthPin, isWeakPin } from '@nem/shared';
import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PinPad, Screen } from '@/components';
import { useSecureScreen } from '@/lib/screenCapture';

import { SignupStepHeader } from '../components/SignupStepHeader';
import { useSignupStore } from '../signupStore';

/** Why a PIN is refused before it ever reaches the bank (AUTH-4). */
export function weakPinMessage(pin: string, dateOfBirth?: string): string | undefined {
  if (dateOfBirth && isDateOfBirthPin(pin, dateOfBirth)) {
    return "Don't use your date of birth. Pick another PIN.";
  }
  if (isWeakPin(pin)) return 'Too easy to guess. Avoid repeats and runs like 1234.';
  return undefined;
}

/** Step 4 of sign-up: the 4-digit transaction PIN, entered twice. */
export function CreatePinScreen() {
  const router = useRouter();
  const pending = useSignupStore((s) => s.pending);
  const savePin = useSignupStore((s) => s.setPin);
  const [first, setFirst] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  useSecureScreen();

  if (!pending?.password) return <Redirect href="/sign-up" />;
  const dateOfBirth = pending.request.date_of_birth;

  const choose = async (pin: string) => {
    const weak = weakPinMessage(pin, dateOfBirth);
    setError(weak);
    if (weak) return false;
    setFirst(pin);
    return true;
  };

  const confirm = async (pin: string) => {
    if (pin !== first) {
      setFirst(null);
      setError("The PINs didn't match. Choose your PIN again.");
      return false;
    }
    setError(undefined);
    savePin(pin);
    router.push('/enable-biometrics');
    return true;
  };

  return (
    <Screen header={<SignupStepHeader step={4} />} scroll={false} edges={['top', 'bottom']}>
      <View style={styles.pad}>
        {first === null ? (
          <PinPad
            key="choose"
            title="Create your PIN"
            subtitle="4 digits to approve payments and unlock the app"
            error={error}
            onComplete={choose}
          />
        ) : (
          <PinPad
            key="confirm"
            title="Confirm your PIN"
            subtitle="Enter the same 4 digits again"
            error={error}
            onComplete={confirm}
          />
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  pad: { flex: 1, justifyContent: 'center' },
});
