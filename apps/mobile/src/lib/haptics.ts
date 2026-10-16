import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

// One place for haptic feedback so every control feels the same and a future
// "haptics off" setting has a single switch.

export type HapticKind = 'tap' | 'selection' | 'success' | 'warning' | 'error';

const PLAYERS: Record<HapticKind, () => Promise<void>> = {
  tap: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  selection: () => Haptics.selectionAsync(),
  success: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  warning: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  error: () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
};

/** Fire-and-forget. Haptics are a nicety: an unsupported device must never break a tap. */
export function haptic(kind: HapticKind): void {
  if (Platform.OS === 'web') return;
  PLAYERS[kind]().catch(() => undefined);
}
