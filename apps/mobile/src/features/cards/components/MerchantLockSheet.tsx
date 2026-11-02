import type { Schema } from '@nem/contracts';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { BottomSheet, Button, Chip, Text } from '@/components';
import { useTheme } from '@/theme';

import { LOCKABLE_MERCHANTS } from '../cards';

type Card = Schema<'Card'>;
type Lock = Schema<'MerchantLock'>;

export type Props = {
  card: Card;
  open: boolean;
  onClose: () => void;
  onSave: (lock: Lock | null) => void;
  saving: boolean;
};

/**
 * Locks a card to one merchant, or lifts the lock (CARD-4). A merchant-locked
 * card can move to another merchant but never become an open card.
 */
export function MerchantLockSheet({ card, open, onClose, onSave, saving }: Props) {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const mustLock = card.type === 'merchant_locked';
  const [lock, setLock] = useState<Lock | null>(card.controls.merchant_lock);
  const unchanged = lock?.merchant_id === card.controls.merchant_lock?.merchant_id;

  return (
    <BottomSheet open={open} onClose={onClose} title={t('cards.controls.lockTitle')}>
      <View style={{ gap: spacing[4] }}>
        <Text color="textMuted">{mustLock ? t('cards.lock.must') : t('cards.lock.optional')}</Text>
        <View style={[styles.chips, { gap: spacing[2] }]}>
          {!mustLock && (
            <Chip
              label={t('cards.controls.anyMerchant')}
              selected={lock === null}
              onPress={() => setLock(null)}
            />
          )}
          {LOCKABLE_MERCHANTS.map((m) => (
            <Chip
              key={m.merchant_id}
              label={m.merchant_name}
              selected={lock?.merchant_id === m.merchant_id}
              onPress={() => setLock(m)}
            />
          ))}
        </View>
        <Button
          label={t('common.save')}
          fullWidth
          disabled={unchanged || (mustLock && !lock)}
          loading={saving}
          onPress={() => onSave(lock)}
        />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
});
