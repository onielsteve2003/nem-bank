import { StyleSheet, View } from 'react-native';

import { type ColorTokens } from '@nem/shared';

import { useTheme } from '@/theme';

import { Text } from './Text';

export type TimelineStep = {
  status: string;
  label: string;
  /** ISO timestamp. */
  at: string;
  detail?: string | null;
};

/** Green for done, red for failed, amber while waiting on someone, volt otherwise. */
export function stepTone(status: string): keyof ColorTokens {
  switch (status) {
    case 'completed':
    case 'settled':
    case 'stepped_up':
      return 'success';
    case 'failed':
    case 'rejected':
    case 'cancelled':
      return 'danger';
    case 'reversed':
      return 'info';
    case 'pending_step_up':
    case 'delayed':
    case 'held_for_review':
      return 'warning';
    default:
      return 'primaryText';
  }
}

export type Props = {
  steps: readonly TimelineStep[];
  formatAt: (iso: string) => string;
  /** The step still to come, drawn hollow, e.g. "Credited to Chidi". */
  next?: string;
};

/**
 * A vertical status history (ACC-6, TRF-7): one dot per step, oldest first. Each
 * step is read as one sentence; the list is a live region so a new step is
 * announced as it arrives.
 */
export function StatusTimeline({ steps, formatAt, next }: Props) {
  const { colors, spacing } = useTheme();
  return (
    <View accessibilityRole="list" accessibilityLiveRegion="polite">
      {steps.map((step, i) => {
        const last = i === steps.length - 1 && !next;
        return (
          <View
            key={`${step.status}-${step.at}-${i}`}
            style={styles.row}
            accessible
            accessibilityLabel={`${step.label}, ${formatAt(step.at)}${step.detail ? `. ${step.detail}` : ''}`}
          >
            <View style={styles.rail}>
              <View style={[styles.dot, { backgroundColor: colors[stepTone(step.status)] }]} />
              {!last && <View style={[styles.line, { backgroundColor: colors.border }]} />}
            </View>
            <View style={[styles.flex, { paddingBottom: last ? 0 : spacing[4] }]}>
              <Text variant="bodyStrong">{step.label}</Text>
              <Text variant="caption" color="textMuted">
                {formatAt(step.at)}
              </Text>
              {step.detail ? <Text variant="caption">{step.detail}</Text> : null}
            </View>
          </View>
        );
      })}
      {next && (
        <View style={styles.row} accessible accessibilityLabel={`Next: ${next}`}>
          <View style={styles.rail}>
            <View style={[styles.dot, styles.hollow, { borderColor: colors.textMuted }]} />
          </View>
          <View style={styles.flex}>
            <Text color="textMuted">{next}</Text>
            <Text variant="caption" color="textMuted">
              Waiting…
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'stretch' },
  rail: { width: 24, alignItems: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6, marginTop: 4 },
  hollow: { backgroundColor: 'transparent', borderWidth: 2 },
  line: { width: 2, flex: 1, marginTop: 2 },
  flex: { flex: 1 },
});
