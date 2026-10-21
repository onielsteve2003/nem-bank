import type { Schema } from '@nem/contracts';
import { lagosToday, parseDisplayDate } from '@nem/shared';
import { CalendarClock } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BottomSheet, Button, Chip, Text, TextField } from '@/components';
import { useTheme } from '@/theme';

import {
  describeSchedule,
  FREQUENCIES,
  scheduleError,
  startPresets,
  type ScheduleChoice,
} from '../schedule';

type Frequency = Schema<'ScheduleFrequency'>;

interface Props {
  /** The schedule already chosen, or null when the payment goes now. */
  value: ScheduleChoice | null;
  onClose: () => void;
  /** null means "send it now" again. */
  onApply: (choice: ScheduleChoice | null) => void;
}

const isoToDisplay = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * When the payment goes (TRF-9): once on a later day, or every day, week or
 * month from a first day, until cancelled or a last day. Mount it only while
 * open, so it starts from the current choice each time.
 */
export function ScheduleSheet({ value, onClose, onApply }: Props) {
  const { spacing } = useTheme();
  const today = lagosToday();
  const presets = startPresets(today);
  const [frequency, setFrequency] = useState<Frequency>(value?.frequency ?? 'once');
  const initialPreset = presets.find((p) => p.date === value?.startDate)?.key ?? null;
  const [preset, setPreset] = useState<string>(value ? (initialPreset ?? 'custom') : 'tomorrow');
  const [customStart, setCustomStart] = useState(
    value && !initialPreset ? isoToDisplay(value.startDate) : '',
  );
  const [hasEnd, setHasEnd] = useState(Boolean(value?.endsOn));
  const [customEnd, setCustomEnd] = useState(value?.endsOn ? isoToDisplay(value.endsOn) : '');

  const startDate =
    preset === 'custom'
      ? parseDisplayDate(customStart)
      : (presets.find((p) => p.key === preset)?.date ?? null);
  const endsOn = frequency !== 'once' && hasEnd ? parseDisplayDate(customEnd) : null;
  const choice = startDate ? { frequency, startDate, endsOn } : null;
  const typedBadly =
    (preset === 'custom' && customStart.length === 10 && !startDate) ||
    (frequency !== 'once' && hasEnd && customEnd.length === 10 && !endsOn);
  const error = typedBadly
    ? 'Use real dates in DD/MM/YYYY'
    : choice
      ? scheduleError(choice, today)
      : null;
  const ready = choice && !error && !(frequency !== 'once' && hasEnd && !endsOn);

  return (
    <BottomSheet open onClose={onClose} title="When should it go?">
      <View style={{ gap: spacing[4] }}>
        <View style={{ gap: spacing[2] }}>
          <Text variant="label" color="textMuted">
            How often
          </Text>
          <View accessibilityRole="radiogroup" style={[styles.wrap, { gap: spacing[2] }]}>
            {(Object.keys(FREQUENCIES) as Frequency[]).map((f) => (
              <Chip
                key={f}
                label={FREQUENCIES[f]}
                selected={frequency === f}
                onPress={() => setFrequency(f)}
              />
            ))}
          </View>
        </View>

        <View style={{ gap: spacing[2] }}>
          <Text variant="label" color="textMuted">
            {frequency === 'once' ? 'On' : 'First payment'}
          </Text>
          <View accessibilityRole="radiogroup" style={[styles.wrap, { gap: spacing[2] }]}>
            {presets.map((p) => (
              <Chip
                key={p.key}
                label={p.label}
                selected={preset === p.key}
                onPress={() => setPreset(p.key)}
              />
            ))}
            <Chip
              label="Pick a day"
              selected={preset === 'custom'}
              onPress={() => setPreset('custom')}
            />
          </View>
          {preset === 'custom' && (
            <TextField
              label="Day"
              placeholder="DD/MM/YYYY"
              keyboardType="numbers-and-punctuation"
              value={customStart}
              onChangeText={setCustomStart}
              maxLength={10}
            />
          )}
        </View>

        {frequency !== 'once' && (
          <View style={{ gap: spacing[2] }}>
            <Text variant="label" color="textMuted">
              Ends
            </Text>
            <View accessibilityRole="radiogroup" style={[styles.wrap, { gap: spacing[2] }]}>
              <Chip label="When I cancel" selected={!hasEnd} onPress={() => setHasEnd(false)} />
              <Chip label="On a day" selected={hasEnd} onPress={() => setHasEnd(true)} />
            </View>
            {hasEnd && (
              <TextField
                label="Last day"
                placeholder="DD/MM/YYYY"
                keyboardType="numbers-and-punctuation"
                value={customEnd}
                onChangeText={setCustomEnd}
                maxLength={10}
              />
            )}
          </View>
        )}

        {error ? (
          <Text variant="bodySmall" color="danger" accessibilityRole="alert">
            {error}
          </Text>
        ) : choice ? (
          <Text variant="bodySmall" color="textMuted" accessibilityLiveRegion="polite">
            {describeSchedule(choice)}, at about 9 am. The fee applies to each payment.
          </Text>
        ) : null}

        <Button
          label="Use this schedule"
          icon={CalendarClock}
          disabled={!ready}
          onPress={() => choice && onApply(choice)}
        />
        {value && <Button label="Send now instead" variant="ghost" onPress={() => onApply(null)} />}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
});
