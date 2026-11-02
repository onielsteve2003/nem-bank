import { isDateOfBirthPin, isWeakPin } from '@nem/shared';
import { Redirect, useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PinPad, Screen } from '@/components';
import { useSecureScreen } from '@/lib/screenCapture';

import { SignupStepHeader } from '../components/SignupStepHeader';
import { useSignupStore } from '../signupStore';
import { useTranslation } from 'react-i18next';
import i18n from '@/lib/i18n';

/** Why a PIN is refused before it ever reaches the bank (AUTH-4). */
export function weakPinMessage(pin: string, dateOfBirth?: string): string | undefined {
  if (dateOfBirth && isDateOfBirthPin(pin, dateOfBirth)) {
    return i18n.t('auth.pin.dateOfBirth');
  }
  if (isWeakPin(pin)) return i18n.t('auth.pin.weak');
  return undefined;
}

/** Step 4 of sign-up: the 4-digit transaction PIN, entered twice. */
export function CreatePinScreen() {
  const router = useRouter();
  const pending = useSignupStore((s) => s.pending);
  const savePin = useSignupStore((s) => s.setPin);
  const [first, setFirst] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const { t } = useTranslation();
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
      setError(t('auth.pin.mismatch'));
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
            title={t('auth.pin.create')}
            subtitle={t('auth.pin.subtitle')}
            error={error}
            onComplete={choose}
          />
        ) : (
          <PinPad
            key="confirm"
            title={t('auth.pin.confirm')}
            subtitle={t('auth.pin.confirmSubtitle')}
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
