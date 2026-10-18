import { Zap } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Icon, Text } from '@/components';
import { useAppLocked, useLockStore } from '@/stores';
import { useTheme } from '@/theme';

import { LockScreen } from './LockScreen';
import { useAutoLock } from './useAutoLock';

/**
 * Sits over the whole navigator (T4.4). It is an overlay, not a route, so
 * unlocking returns the user to exactly where they were, mid-flow included.
 */
export function AppLock() {
  const locked = useAppLocked();
  const authenticating = useLockStore((s) => s.authenticating);
  const { obscured } = useAutoLock();

  return (
    <>
      {locked && (
        <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
          <LockScreen />
        </View>
      )}
      {obscured && !authenticating && <PrivacyCover />}
    </>
  );
}

/** Covers the app in the app switcher, so balances never show in its snapshot (AUTH-12). */
function PrivacyCover() {
  const { colors, spacing } = useTheme();
  return (
    <View
      testID="privacy-cover"
      importantForAccessibility="no-hide-descendants"
      style={[styles.cover, { backgroundColor: colors.background, gap: spacing[2] }]}
    >
      <Icon icon={Zap} size="xl" color="primaryText" />
      <Text variant="h2">Nem Bank</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
});
