import type { Schema } from '@nem/contracts';
import { useState } from 'react';
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
  const mustLock = card.type === 'merchant_locked';
  const [lock, setLock] = useState<Lock | null>(card.controls.merchant_lock);
  const unchanged = lock?.merchant_id === card.controls.merchant_lock?.merchant_id;

  return (
    <BottomSheet open={open} onClose={onClose} title="Merchant lock">
      <View style={{ gap: spacing[4] }}>
        <Text color="textMuted">
          {mustLock
            ? 'This card only works at one merchant. Pick which.'
            : 'Lock the card to one merchant and it is declined everywhere else.'}
        </Text>
        <View style={[styles.chips, { gap: spacing[2] }]}>
          {!mustLock && (
            <Chip label="Any merchant" selected={lock === null} onPress={() => setLock(null)} />
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
          label="Save"
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
