import {
  CircleAlert,
  Info,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { Icon } from './Icon';
import { Text, type TextColor } from './Text';

export type RiskSeverity = 'high' | 'medium' | 'low';

export type RiskReason = {
  /** Stable reason code from the scorer, e.g. "NEW_DEVICE". */
  code: string;
  /** Plain-language reason, e.g. "First transfer from this device". */
  label: string;
  severity: RiskSeverity;
};

/** Icon plus word for each level, so severity never relies on colour alone. */
export const SEVERITY_META: Record<
  RiskSeverity,
  { label: string; icon: LucideIcon; color: TextColor; rank: number }
> = {
  high: { label: 'High', icon: TriangleAlert, color: 'danger', rank: 0 },
  medium: { label: 'Medium', icon: CircleAlert, color: 'warning', rank: 1 },
  low: { label: 'Low', icon: Info, color: 'info', rank: 2 },
};

/** Most severe first; ties keep the scorer's order. */
export function sortReasons(reasons: readonly RiskReason[]): RiskReason[] {
  return [...reasons].sort(
    (a, b) => SEVERITY_META[a.severity].rank - SEVERITY_META[b.severity].rank,
  );
}

export type Props = {
  reasons: readonly RiskReason[];
  title?: string;
};

/** The "why" behind a risk decision (AI-1, ADM-5): each reason code with its severity. */
export function RiskReasonList({ reasons, title = 'Why this was flagged' }: Props) {
  const { colors, radius, spacing } = useTheme();

  if (reasons.length === 0) {
    return (
      <View accessible style={[styles.row, { gap: spacing[2] }]}>
        <Icon icon={ShieldCheck} size="sm" color="success" />
        <Text variant="bodySmall" color="textMuted">
          No risk signals found.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ gap: spacing[2] }}>
      <Text variant="label" color="textMuted" accessibilityRole="header">
        {title}
      </Text>
      <View accessibilityRole="list" style={{ gap: spacing[2] }}>
        {sortReasons(reasons).map((reason) => {
          const meta = SEVERITY_META[reason.severity];
          return (
            <View
              key={reason.code}
              accessible
              accessibilityLabel={`${meta.label} risk: ${reason.label}`}
              style={[
                styles.row,
                {
                  gap: spacing[3],
                  padding: spacing[3],
                  borderRadius: radius.md,
                  backgroundColor: colors.raised,
                },
              ]}
            >
              <Icon icon={meta.icon} size="md" color={meta.color} />
              <View style={styles.flex}>
                <Text variant="body">{reason.label}</Text>
                <Text variant="caption" color={meta.color}>
                  {meta.label} risk
                </Text>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
