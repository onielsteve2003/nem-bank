import { useRouter } from 'expo-router';
import { ArrowLeft, X, type LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { EmptyState, IconButton, Screen, Text } from '@/components';
import { useTheme } from '@/theme';

export type Props = {
  title: string;
  icon: LucideIcon;
  /** What will live here, in the user's words. */
  message: string;
  /** Modals get a close button, stack screens a back button; tabs leave the bottom inset to the tab bar. */
  variant?: 'tab' | 'modal' | 'stack';
  /** Links or actions shown under the message. */
  children?: ReactNode;
};

/**
 * Holds a route's place in the navigation structure (T4.1) until its feature is
 * built, so the shell can be walked end to end on a phone.
 */
export function PlaceholderScreen({ title, icon, message, variant = 'tab', children }: Props) {
  const router = useRouter();
  const { spacing } = useTheme();

  const header = (
    <View
      style={[
        styles.header,
        { paddingHorizontal: spacing[4], paddingTop: spacing[2], gap: spacing[2] },
      ]}
    >
      {variant === 'stack' && router.canGoBack() && (
        <IconButton
          icon={ArrowLeft}
          accessibilityLabel="Back"
          variant="ghost"
          onPress={() => router.back()}
        />
      )}
      <Text variant="h2" style={styles.title}>
        {title}
      </Text>
      {variant === 'modal' && (
        <IconButton
          icon={X}
          accessibilityLabel="Close"
          variant="ghost"
          onPress={() => router.back()}
        />
      )}
    </View>
  );

  return (
    <Screen header={header} edges={variant === 'tab' ? ['top'] : ['top', 'bottom']}>
      <EmptyState icon={icon} title={`${title} is on its way`} message={message} />
      {children}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  title: { flex: 1 },
});
