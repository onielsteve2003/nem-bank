import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { haptic } from '@/lib/haptics';
import { useTheme } from '@/theme';

import { Text } from './Text';

export type Props = {
  label: string;
  /** Index of the selected step, 0 to `steps - 1`. */
  value: number;
  steps: number;
  onChange: (value: number) => void;
  /** What the selected step means, spoken by VoiceOver ("₦50,000"). */
  valueText: string;
  minLabel?: string;
  maxLabel?: string;
  disabled?: boolean;
};

const THUMB = 28;
const TRACK = 6;

/**
 * A stepped slider: drag or tap anywhere on the track. VoiceOver reads it as
 * adjustable and swipes up or down one step, so it never needs the gesture.
 */
export function Slider({
  label,
  value,
  steps,
  onChange,
  valueText,
  minLabel,
  maxLabel,
  disabled = false,
}: Props) {
  const { colors, spacing, radius } = useTheme();
  const [width, setWidth] = useState(0);
  const last = steps - 1;
  // Where the finger first landed (track x) and its page x, so a drag can
  // leave the track vertically without jumping.
  const grant = useRef({ x: 0, pageX: 0 });

  const select = (next: number) => {
    const clamped = Math.max(0, Math.min(last, next));
    if (clamped === value) return;
    haptic('selection');
    onChange(clamped);
  };

  const stepAt = (x: number) => {
    const usable = width - THUMB;
    if (usable <= 0 || last <= 0) return 0;
    return Math.round(((x - THUMB / 2) / usable) * last);
  };

  const offset = last > 0 && width > THUMB ? (value / last) * (width - THUMB) : 0;

  return (
    <View style={{ gap: spacing[2] }}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text: valueText }}
        accessibilityState={{ disabled }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) =>
          select(value + (e.nativeEvent.actionName === 'increment' ? 1 : -1))
        }
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={[styles.hit, disabled && styles.disabled]}
        onStartShouldSetResponder={() => !disabled}
        onMoveShouldSetResponder={() => !disabled}
        // Keep the drag when the finger drifts vertically inside a scroll view.
        onResponderTerminationRequest={() => false}
        onResponderGrant={(e) => {
          grant.current = { x: e.nativeEvent.locationX, pageX: e.nativeEvent.pageX };
          select(stepAt(grant.current.x));
        }}
        onResponderMove={(e) =>
          select(stepAt(grant.current.x + e.nativeEvent.pageX - grant.current.pageX))
        }
      >
        <View
          pointerEvents="none"
          style={[
            styles.track,
            {
              borderRadius: radius.pill,
              backgroundColor: colors.border,
              marginHorizontal: THUMB / 2,
            },
          ]}
        >
          <View
            style={[
              styles.fill,
              { width: offset, borderRadius: radius.pill, backgroundColor: colors.primary },
            ]}
          />
        </View>
        <View
          pointerEvents="none"
          style={[
            styles.thumb,
            {
              left: offset,
              borderRadius: radius.pill,
              backgroundColor: colors.primary,
              borderColor: colors.surface,
            },
          ]}
        />
      </View>
      {(minLabel || maxLabel) && (
        <View
          style={styles.ends}
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
        >
          <Text variant="caption" color="textMuted">
            {minLabel}
          </Text>
          <Text variant="caption" color="textMuted">
            {maxLabel}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // 44 pt tall so the whole track is an easy target.
  hit: { minHeight: 44, justifyContent: 'center' },
  track: { height: TRACK, overflow: 'hidden' },
  fill: { height: TRACK },
  thumb: { position: 'absolute', width: THUMB, height: THUMB, borderWidth: 3 },
  ends: { flexDirection: 'row', justifyContent: 'space-between' },
  disabled: { opacity: 0.5 },
});
