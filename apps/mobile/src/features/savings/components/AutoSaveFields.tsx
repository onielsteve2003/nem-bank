import { StyleSheet, View } from 'react-native';

import { Chip, Switch, Text } from '@/components';
import { useTheme } from '@/theme';

import { AUTO_SAVE_FREQUENCIES, AUTO_SAVE_PRESETS, type AutoSaveFrequency } from '../goals';

export interface AutoSaveChoice {
  /** Naira, whole. */
  amount: number;
  frequency: AutoSaveFrequency;
}

interface Props {
  value: AutoSaveChoice | null;
  onChange: (value: AutoSaveChoice | null) => void;
}

/** The auto-save rule (SAV-2): off, or an amount every day, week or month. */
export function AutoSaveFields({ value, onChange }: Props) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing[3] }}>
      <Switch
        label="Auto-save"
        description="Move money from your naira account into this goal on a schedule. It stops when you reach the target."
        value={value !== null}
        onValueChange={(on) => onChange(on ? { amount: 5_000, frequency: 'weekly' } : null)}
      />
      {value && (
        <>
          <View style={{ gap: spacing[2] }}>
            <Text variant="label" color="textMuted">
              How much
            </Text>
            <View accessibilityRole="radiogroup" style={[styles.wrap, { gap: spacing[2] }]}>
              {AUTO_SAVE_PRESETS.map((n) => (
                <Chip
                  key={n}
                  label={`₦${n.toLocaleString('en-NG')}`}
                  selected={value.amount === n}
                  onPress={() => onChange({ ...value, amount: n })}
                />
              ))}
            </View>
          </View>
          <View style={{ gap: spacing[2] }}>
            <Text variant="label" color="textMuted">
              How often
            </Text>
            <View accessibilityRole="radiogroup" style={[styles.wrap, { gap: spacing[2] }]}>
              {(Object.keys(AUTO_SAVE_FREQUENCIES) as AutoSaveFrequency[]).map((f) => (
                <Chip
                  key={f}
                  label={AUTO_SAVE_FREQUENCIES[f]}
                  selected={value.frequency === f}
                  onPress={() => onChange({ ...value, frequency: f })}
                />
              ))}
            </View>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
});
