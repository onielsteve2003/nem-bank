import {
  CircleCheck,
  CircleX,
  Clock,
  LoaderCircle,
  ShieldAlert,
  Undo2,
  type LucideIcon,
} from '@/components/icons';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useReduceMotion } from '@/lib/motion';
import { withLabel } from '@/lib/i18n';
import { useTheme } from '@/theme';

import { Icon } from './Icon';
import { Text } from './Text';
import { TONE_PALETTE, type Tone } from './tone';

export type TransactionStatus =
  'pending' | 'processing' | 'completed' | 'failed' | 'reversed' | 'held';

/** Each status has its own icon and word, so it never relies on colour alone. */
export const STATUS_META: Record<
  TransactionStatus,
  { label: string; tone: Tone; icon: LucideIcon }
> = {
  pending: withLabel('components.status.pending', { tone: 'warning', icon: Clock }),
  processing: withLabel('components.status.processing', { tone: 'info', icon: LoaderCircle }),
  completed: withLabel('components.status.completed', { tone: 'success', icon: CircleCheck }),
  failed: withLabel('components.status.failed', { tone: 'danger', icon: CircleX }),
  reversed: withLabel('components.status.reversed', { tone: 'neutral', icon: Undo2 }),
  held: withLabel('components.status.held', { tone: 'warning', icon: ShieldAlert }),
};

const SPIN_MS = 1000;

export type Props = {
  status: TransactionStatus;
  /** Overrides the default word, e.g. "Refunded" for a reversed card payment. */
  label?: string;
};

export function StatusPill({ status, label }: Props) {
  const { colors, radius, spacing } = useTheme();
  const meta = STATUS_META[status];
  const palette = TONE_PALETTE[meta.tone];
  const text = label ?? meta.label;

  return (
    <View
      accessible
      accessibilityLabel={`Status: ${text}`}
      style={[
        styles.pill,
        {
          gap: spacing[1],
          paddingHorizontal: spacing[2],
          borderRadius: radius.pill,
          backgroundColor: colors[palette.fill],
        },
      ]}
    >
      <Spinner active={status === 'processing'}>
        <Icon icon={meta.icon} size="sm" color={palette.fg} />
      </Spinner>
      <Text variant="caption" style={{ color: colors[palette.fg] }} maxFontSizeMultiplier={1.4}>
        {text}
      </Text>
    </View>
  );
}

/** Slowly turns the processing icon. Still with reduce motion. */
function Spinner({ active, children }: { active: boolean; children: React.ReactNode }) {
  const reduceMotion = useReduceMotion();
  const turn = useSharedValue(0);

  useEffect(() => {
    if (!active || reduceMotion) return;
    turn.set(withRepeat(withTiming(1, { duration: SPIN_MS, easing: Easing.linear }), -1, false));
    return () => {
      cancelAnimation(turn);
      turn.set(0);
    };
  }, [active, reduceMotion, turn]);

  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    minHeight: 24,
  },
});
