import { StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';

import { Icon, Text } from '@/components';
import { useTheme } from '@/theme';

import { scoreBand } from '../security';

const SIZE = 144;
const STROKE = 12;
const R = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * R;

export type Props = { score: number };

/** The checkup score as a ring, with the number and its band in words (SEC-1). */
export function ScoreRing({ score }: Props) {
  const { colors, spacing } = useTheme();
  const band = scoreBand(score);
  const clamped = Math.max(0, Math.min(100, score));

  return (
    <View
      style={[styles.center, { gap: spacing[3] }]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Security score ${clamped} out of 100. ${band.label}.`}
      accessibilityValue={{ min: 0, max: 100, now: clamped }}
    >
      <View style={styles.ring}>
        <Svg width={SIZE} height={SIZE}>
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            stroke={colors.border}
            strokeWidth={STROKE}
            fill="none"
          />
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            stroke={colors[band.color]}
            strokeWidth={STROKE}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            strokeDashoffset={CIRCUMFERENCE * (1 - clamped / 100)}
            // Start at twelve o'clock and fill clockwise.
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          />
        </Svg>
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <Text variant="h1">{clamped}</Text>
          <Text variant="caption" color="textMuted">
            out of 100
          </Text>
        </View>
      </View>
      <View style={[styles.row, { gap: spacing[2] }]}>
        <Icon icon={band.icon} color={band.color} />
        <Text variant="bodyStrong" color={band.color}>
          {band.label}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  ring: { width: SIZE, height: SIZE },
  row: { flexDirection: 'row', alignItems: 'center' },
});
