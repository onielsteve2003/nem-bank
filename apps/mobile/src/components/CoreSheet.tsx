import { X } from 'lucide-react-native';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type DimensionValue,
} from 'react-native';
import Animated, { SlideInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

import type { Props as BottomSheetProps } from './BottomSheet';
import { IconButton } from './IconButton';
import { useModalFrameStyle } from './modalFrame';
import { Text } from './Text';

/**
 * BottomSheet's look on the core `Modal`, for flows presented as native modals
 * (ModalSheetHost). Same props and behaviour: backdrop tap, close button and
 * the Android back button all call `onClose`.
 */
export function CoreSheet({
  open,
  onClose,
  title,
  children,
  snapPoints,
  hideCloseButton = false,
}: BottomSheetProps) {
  const { colors, radius, spacing, motion } = useTheme();
  const insets = useSafeAreaInsets();
  const frameStyle = useModalFrameStyle();
  // The tallest snap point sets a fixed height (a long list); otherwise the sheet fits its content.
  const tallest = snapPoints?.at(-1);
  const height = tallest === undefined ? undefined : (tallest as DimensionValue);

  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.backdrop, { backgroundColor: colors.overlay }, frameStyle]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close sheet"
          style={StyleSheet.absoluteFill}
          onPress={onClose}
        />
        <Animated.View
          entering={SlideInDown.duration(motion.duration.base)}
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              height,
              backgroundColor: colors.surface,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              paddingTop: spacing[2],
            },
          ]}
        >
          <View
            style={[styles.handle, { backgroundColor: colors.border, marginBottom: spacing[2] }]}
          />
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingHorizontal: spacing[4],
              paddingBottom: insets.bottom + spacing[4],
              gap: spacing[3],
            }}
          >
            {(title || !hideCloseButton) && (
              <View style={styles.header}>
                {title ? (
                  <Text variant="h3" style={styles.flex}>
                    {title}
                  </Text>
                ) : (
                  <View style={styles.flex} />
                )}
                {!hideCloseButton && (
                  <IconButton
                    icon={X}
                    accessibilityLabel="Close"
                    variant="ghost"
                    onPress={onClose}
                  />
                )}
              </View>
            )}
            {children}
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { maxHeight: '92%' },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2 },
  header: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
