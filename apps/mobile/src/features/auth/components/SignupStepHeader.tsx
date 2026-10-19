import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { IconButton, Text } from '@/components';
import { useTheme } from '@/theme';

/** Details, email code, password, PIN. Biometrics is an optional extra at the end. */
export const SIGNUP_STEPS = 4;

/** Back button and "Step n of 4" above every sign-up screen. */
export function SignupStepHeader({ step }: { step: number }) {
  const router = useRouter();
  const { spacing } = useTheme();
  return (
    <View style={[styles.header, { paddingHorizontal: spacing[4], gap: spacing[2] }]}>
      {router.canGoBack() && (
        <IconButton
          icon={ArrowLeft}
          accessibilityLabel="Back"
          variant="ghost"
          onPress={() => router.back()}
        />
      )}
      <Text variant="label" color="textMuted" style={styles.flex}>
        Step {step} of {SIGNUP_STEPS}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  flex: { flex: 1 },
});
