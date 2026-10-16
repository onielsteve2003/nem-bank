import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

export type Props = {
  children: ReactNode;
  /** Fixed above the content, e.g. a back button and title. */
  header?: ReactNode;
  /** Pinned below the content and lifted with the keyboard, e.g. a Continue button. */
  footer?: ReactNode;
  /** `false` for screens that manage their own list (FlashList) or fill the viewport. */
  scroll?: boolean;
  /** Adds the standard 16 pt gutter and section gap. */
  padded?: boolean;
  /** Enables pull to refresh on scrolling screens. */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Safe-area edges to inset; tab screens drop 'bottom' because the tab bar covers it. */
  edges?: Edge[];
  contentContainerStyle?: StyleProp<ViewStyle>;
};

/** The shell every screen renders in: themed background, safe areas, keyboard avoiding, refresh. */
export function Screen({
  children,
  header,
  footer,
  scroll = true,
  padded = true,
  onRefresh,
  refreshing = false,
  edges = ['top', 'bottom'],
  contentContainerStyle,
}: Props) {
  const { colors, spacing } = useTheme();
  const padding = padded ? { padding: spacing[4], gap: spacing[6] } : undefined;

  const body = scroll ? (
    <ScrollView
      testID="screen-scroll"
      style={styles.flex}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={[padding, contentContainerStyle]}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primaryText}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surface}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, padding, contentContainerStyle]}>{children}</View>
  );

  return (
    <SafeAreaView edges={edges} style={[styles.flex, { backgroundColor: colors.background }]}>
      {header}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {body}
        {footer && (
          <View style={{ paddingHorizontal: spacing[4], paddingVertical: spacing[3] }}>
            {footer}
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
