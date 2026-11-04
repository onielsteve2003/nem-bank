import { useRouter } from 'expo-router';
import { ArrowLeft } from '@/components/icons';
import { StyleSheet, View } from 'react-native';

import { IconButton, Text } from '@/components';
import { useTheme } from '@/theme';
import { useTranslation } from 'react-i18next';

/** Details, email code, password, PIN. Biometrics is an optional extra at the end. */
export const SIGNUP_STEPS = 4;

/**
 * Back button and "Step n of 4" above every sign-up screen; no step for the
 * optional extras. Other signed-out screens pass their own `label`.
 */
export function SignupStepHeader({ step, label }: { step?: number; label?: string }) {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  return (
    <View style={[styles.header, { paddingHorizontal: spacing[4], gap: spacing[2] }]}>
      {router.canGoBack() && (
        <IconButton
          icon={ArrowLeft}
          accessibilityLabel={t('common.back')}
          variant="ghost"
          onPress={() => router.back()}
        />
      )}
      <Text variant="label" color="textMuted" style={styles.flex}>
        {label ??
          (step ? t('auth.step.of', { step, total: SIGNUP_STEPS }) : t('auth.step.almostDone'))}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  flex: { flex: 1 },
});
