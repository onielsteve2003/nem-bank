import { Modal, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated';

import { useTheme } from '@/theme';

import { Button } from './Button';
import { useModalFrameStyle } from './modalFrame';
import { Text } from './Text';

export type Props = {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel: string;
  onConfirm: () => void;
  /** Also called for the Android back button and a backdrop tap. */
  onCancel: () => void;
  cancelLabel?: string;
  /** Red confirm button for irreversible actions (delete, freeze, sign out everywhere). */
  destructive?: boolean;
  /** Keeps the dialog open with a busy confirm button while the action runs. */
  loading?: boolean;
};

/** A centred confirmation dialog. Use it for decisions; use BottomSheet for content. */
export function Dialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  cancelLabel = 'Cancel',
  destructive = false,
  loading = false,
}: Props) {
  const { colors, radius, spacing, motion, elevation } = useTheme();
  const frameStyle = useModalFrameStyle();
  const cancel = () => {
    if (!loading) onCancel();
  };

  return (
    <Modal visible={open} transparent animationType="none" onRequestClose={cancel}>
      <Animated.View
        entering={FadeIn.duration(motion.duration.fast)}
        style={[
          styles.backdrop,
          { backgroundColor: colors.overlay, padding: spacing[6] },
          frameStyle,
        ]}
      >
        {/* Tap-outside is a shortcut only: the Cancel button is the accessible way out,
            so screen-reader focus starts on the dialog title, not on the backdrop. */}
        <Pressable
          accessible={false}
          importantForAccessibility="no"
          aria-hidden
          style={StyleSheet.absoluteFill}
          onPress={cancel}
        />
        <Animated.View
          entering={ZoomIn.duration(motion.duration.base)}
          accessibilityViewIsModal
          accessibilityRole="alert"
          style={[
            styles.card,
            elevation.high,
            {
              backgroundColor: colors.surface,
              borderRadius: radius.xl,
              padding: spacing[6],
              gap: spacing[3],
            },
          ]}
        >
          <Text variant="h3">{title}</Text>
          {message && <Text color="textMuted">{message}</Text>}
          <View style={[styles.actions, { gap: spacing[2], marginTop: spacing[3] }]}>
            <Button
              label={confirmLabel}
              variant={destructive ? 'danger' : 'primary'}
              loading={loading}
              fullWidth
              onPress={onConfirm}
            />
            <Button
              label={cancelLabel}
              variant="ghost"
              disabled={loading}
              fullWidth
              onPress={cancel}
            />
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: { width: '100%', maxWidth: 400 },
  actions: { alignSelf: 'stretch' },
});
