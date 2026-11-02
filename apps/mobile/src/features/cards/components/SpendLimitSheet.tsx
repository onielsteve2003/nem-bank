import type { Schema } from '@nem/contracts';
import { CURRENCIES, formatMoney, money } from '@nem/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { BottomSheet, Button, Chip, TextField } from '@/components';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { LIMIT_PERIODS, parseLimit, type LimitPeriod } from '../cards';

type Card = Schema<'Card'>;

export type Props = {
  card: Card;
  open: boolean;
  onClose: () => void;
  /** Null removes the limit. */
  onSave: (limit: Schema<'SpendLimit'> | null) => void;
  saving: boolean;
};

/** Sets or removes a card's spend limit (CARD-4): an amount per payment, day or month. */
export function SpendLimitSheet({ card, open, onClose, onSave, saving }: Props) {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const current = card.controls.spend_limit;
  const [period, setPeriod] = useState<LimitPeriod>(current?.period ?? 'daily');
  const [text, setText] = useState(
    current
      ? formatMoney(fromApiMoney(current.amount), { symbol: false, trimZeroMinor: true })
      : '',
  );
  const minor = parseLimit(text);
  const symbol = CURRENCIES[card.currency].symbol;

  const save = () => {
    if (minor === null) return;
    onSave({ period, amount: toApiMoney(money(minor, card.currency)) });
  };

  return (
    <BottomSheet open={open} onClose={onClose} title={t('cards.limit.title')}>
      <View style={{ gap: spacing[4] }}>
        <View style={[styles.chips, { gap: spacing[2] }]}>
          {LIMIT_PERIODS.map((p) => (
            <Chip
              key={p.value}
              label={p.label}
              selected={p.value === period}
              onPress={() => setPeriod(p.value)}
            />
          ))}
        </View>
        <TextField
          label={t('cards.limit.label', { currency: card.currency })}
          placeholder={`${symbol}50,000`}
          keyboardType="decimal-pad"
          value={text}
          onChangeText={setText}
          error={text && minor === null ? t('cards.limit.invalid') : undefined}
          help={t('cards.limit.help')}
        />
        <Button
          label={t('cards.limit.save')}
          fullWidth
          disabled={minor === null}
          loading={saving}
          onPress={save}
        />
        {current && (
          <Button
            label={t('cards.limit.remove')}
            variant="ghost"
            fullWidth
            disabled={saving}
            onPress={() => onSave(null)}
          />
        )}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
});
