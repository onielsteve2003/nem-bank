import { compare, formatMoney, money, type Money } from '@nem/shared';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AmountInput, BottomSheet, Button, Chip, Text } from '@/components';
import { typedFromKobo, typedNaira } from '@/features/transfers/amount';
import { useTheme } from '@/theme';

import { limitChange, limitsProblem, type Limit } from '../security';

export type Props = {
  which: 'daily' | 'single';
  daily: Limit;
  single: Limit;
  cap: Money;
  saving: boolean;
  onClose: () => void;
  /** The new value for `which`; the screen decides whether it needs a PIN. */
  onSave: (next: Limit) => void;
};

const PRESETS = [20_000n, 50_000n, 100_000n, 500_000n, 1_000_000n].map((n) => n * 100n);
const short = (m: Money) => formatMoney(m, { trimZeroMinor: true });

/** Edit one self-set limit (SEC-3): presets under the KYC cap, any amount, or no limit. */
export function LimitSheet({ which, daily, single, cap, saving, onClose, onSave }: Props) {
  const { spacing } = useTheme();
  const current = which === 'daily' ? daily : single;
  const [none, setNone] = useState(current === null);
  const [typed, setTyped] = useState(current ? typedFromKobo(current.amount) : '');
  const next: Limit = none ? null : typedNaira(typed);
  const presets = PRESETS.filter((k) => k <= cap.amount).map((k) => money(k, 'NGN'));
  const problem =
    which === 'daily' ? limitsProblem(next, single, cap) : limitsProblem(daily, next, cap);
  const change = limitChange(current, next);
  const label = which === 'daily' ? 'Daily limit' : 'Single transfer limit';

  return (
    <BottomSheet open onClose={onClose} title={label}>
      <View style={{ gap: spacing[4] }}>
        <View accessibilityRole="radiogroup" style={[styles.chips, { gap: spacing[2] }]}>
          {presets.map((p) => (
            <Chip
              key={p.amount.toString()}
              label={short(p)}
              selected={!none && next !== null && compare(next, p) === 0}
              onPress={() => {
                setNone(false);
                setTyped(typedFromKobo(p.amount));
              }}
            />
          ))}
          <Chip label="No limit" selected={none} onPress={() => setNone(true)} />
        </View>
        {none ? (
          <Text variant="bodySmall" color="textMuted">
            {`Only your KYC cap of ${short(cap)} a day applies.`}
          </Text>
        ) : (
          <AmountInput
            currency="NGN"
            value={typed}
            onChangeValue={setTyped}
            label={label}
            maxWholeDigits={9}
            help={`Up to ${short(cap)}, your KYC cap`}
            error={problem}
          />
        )}
        <Text variant="bodySmall" color="textMuted">
          {change === 'raise'
            ? 'Raising a limit needs your PIN and starts in 24 hours, so nobody can raise it and spend at once.'
            : change === 'lower'
              ? 'Lowering a limit applies straight away.'
              : 'This is your limit now.'}
        </Text>
        <Button
          label={change === 'raise' ? 'Raise in 24 hours' : 'Save'}
          disabled={change === 'same' || (!none && next === null) || problem !== undefined}
          loading={saving}
          onPress={() => onSave(next)}
        />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
});
