import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { IconButton, Text } from '@/components';
import { useTheme } from '@/theme';

import { monthYearLabel, shiftMonth } from '../insights';

export type Props = {
  month: string;
  /** The current month: the stepper never goes past it. */
  latest: string;
  earliest: string;
  onChange: (month: string) => void;
};

/** Previous / next month, with the month named in the middle. */
export function MonthStepper({ month, latest, earliest, onChange }: Props) {
  const { spacing } = useTheme();
  const previous = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  return (
    <View style={[styles.row, { gap: spacing[2] }]}>
      <IconButton
        icon={ChevronLeft}
        variant="ghost"
        accessibilityLabel={`Show ${monthYearLabel(previous)}`}
        disabled={month <= earliest}
        onPress={() => onChange(previous)}
      />
      <Text variant="bodyStrong" align="center" style={styles.flex} accessibilityRole="header">
        {monthYearLabel(month)}
      </Text>
      <IconButton
        icon={ChevronRight}
        variant="ghost"
        accessibilityLabel={`Show ${monthYearLabel(next)}`}
        disabled={month >= latest}
        onPress={() => onChange(next)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
