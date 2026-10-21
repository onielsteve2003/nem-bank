import type { Schema } from '@nem/contracts';
import { BellPlus } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BottomSheet, Button, Chip, Text, TextField } from '@/components';
import { useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { alertTargetProblem, nairaRate, pairLabel } from '../rates';

type Direction = Schema<'FxAlert'>['direction'];

export type Props = {
  open: boolean;
  pair: string;
  /** The pair's mid-market rate now, so an alert that would fire at once is refused. */
  midRate: string | undefined;
  onClose: () => void;
  onCreated: (alert: Schema<'FxAlert'>) => void;
};

/** "Tell me when USD/NGN goes above ₦1,650" (FX-2). */
export function CreateAlertSheet({ open, pair, midRate, onClose, onCreated }: Props) {
  const { spacing } = useTheme();
  const [direction, setDirection] = useState<Direction>('above');
  const [typed, setTyped] = useState('');
  const [touched, setTouched] = useState(false);
  const create = useRepoMutation('fx', 'createAlert', { invalidates: [['fx', 'listAlerts']] });

  const problem = alertTargetProblem(typed, direction, pair, midRate);
  const save = async () => {
    setTouched(true);
    if (problem) return;
    try {
      const alert = await create.mutateAsync({
        body: { pair, direction, target_rate: typed.trim() },
      });
      setTyped('');
      setTouched(false);
      onCreated(alert);
    } catch {
      // The error shows under the button.
    }
  };

  return (
    <BottomSheet open={open} onClose={onClose} title={`Alert me about ${pairLabel(pair)}`}>
      <View style={{ gap: spacing[4] }}>
        {midRate && (
          <Text color="textMuted">
            It is {nairaRate(pair, midRate)} now. We notify you once when it crosses your rate.
          </Text>
        )}
        <View style={[styles.row, { gap: spacing[2] }]} accessibilityRole="radiogroup">
          <Chip
            label="Goes above"
            selected={direction === 'above'}
            onPress={() => setDirection('above')}
          />
          <Chip
            label="Goes below"
            selected={direction === 'below'}
            onPress={() => setDirection('below')}
          />
        </View>
        <TextField
          label="Rate in naira"
          placeholder="1650"
          keyboardType="decimal-pad"
          value={typed}
          onChangeText={setTyped}
          onBlur={() => setTouched(true)}
          error={touched && typed !== '' ? (problem ?? undefined) : undefined}
        />
        {create.error && (
          <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
            {create.error.problem.detail ?? create.error.problem.title}
          </Text>
        )}
        <Button
          label="Create alert"
          icon={BellPlus}
          loading={create.isPending}
          disabled={typed === '' || (touched && problem !== null)}
          onPress={save}
        />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
});
