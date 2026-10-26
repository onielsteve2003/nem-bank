import type { Schema } from '@nem/contracts';
import { RefreshCw, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { BottomSheet, Button, ListItem, SectionHeader, Text, useToast } from '@/components';
import { isApiError } from '@/data';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { haptic } from '@/lib/haptics';
import { useMoneyMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { cardName } from '../cards';

type Card = Schema<'Card'>;
type Action = 'replace' | 'terminate';

export type Props = {
  card: Card;
  /** The card that took this one's place. */
  onReplaced?: (card: Card) => void;
};

const COPY: Record<Action, { title: string; points: string[]; confirm: string }> = {
  replace: {
    title: 'Replace this card',
    points: [
      'You get a new card number, expiry and CVV straight away.',
      'This card stops working now. Payments already pending still settle.',
      'Your name, look, limit and merchant lock move to the new card.',
      'Update any subscriptions that use this card.',
    ],
    confirm: 'Replace card',
  },
  terminate: {
    title: 'Terminate this card',
    points: [
      'The card closes for good. You can’t undo this.',
      'New payments are declined. Payments already pending still settle.',
      'Its payments stay in your history.',
    ],
    confirm: 'Terminate card',
  },
};

/**
 * Closing a card (CARD-6): replace it with a new number when it may have
 * leaked, or terminate it for good. Both say what happens first, then need the
 * PIN or Face ID. Each is one idempotent request, so a retry never makes two.
 */
export function CardManage({ card, onReplaced }: Props) {
  const { spacing } = useTheme();
  const toast = useToast();
  const [sheet, setSheet] = useState<Action | null>(null);
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [error, setError] = useState<string>();
  const replace = useMoneyMutation('cards', 'replace', { invalidates: [['cards']] });
  const terminate = useMoneyMutation('cards', 'terminate', { invalidates: [['cards']] });
  const path = { card_id: card.id };

  const run = async () => {
    const action = confirming;
    if (!action) return false;
    setError(undefined);
    try {
      if (action === 'replace') {
        const next = await replace.mutateAsync({ path });
        toast.show({ message: `Your new card ending ${next.last4} is ready`, tone: 'success' });
        onReplaced?.(next);
      } else {
        await terminate.mutateAsync({ path });
        toast.show({ message: `Card ending ${card.last4} terminated` });
      }
      haptic('success');
      setConfirming(null);
      return true;
    } catch (e) {
      setError(
        isApiError(e)
          ? e.problem.code === 'offline'
            ? "You're offline. Reconnect and try again."
            : (e.problem.detail ?? e.problem.title)
          : 'That didn’t go through. Try again; it won’t happen twice.',
      );
      return false;
    }
  };

  const copy = sheet ? COPY[sheet] : null;

  return (
    <View>
      <View style={{ paddingHorizontal: spacing[2] }}>
        <SectionHeader title="Manage card" />
      </View>
      <ListItem
        leading={RefreshCw}
        title="Replace card"
        subtitle="New number if this one may have leaked"
        onPress={() => setSheet('replace')}
      />
      <ListItem
        leading={Trash2}
        title="Terminate card"
        subtitle="Close it for good"
        onPress={() => setSheet('terminate')}
      />

      <BottomSheet open={sheet !== null} onClose={() => setSheet(null)} title={copy?.title}>
        {copy && sheet && (
          <View style={{ gap: spacing[4] }}>
            <Text color="textMuted">{`${cardName(card)} · ends ${card.last4}`}</Text>
            <View style={{ gap: spacing[2] }}>
              {copy.points.map((p) => (
                <Text key={p}>{`•  ${p}`}</Text>
              ))}
            </View>
            <Button
              label={copy.confirm}
              variant={sheet === 'terminate' ? 'danger' : 'primary'}
              fullWidth
              onPress={() => {
                setError(undefined);
                setConfirming(sheet);
                setSheet(null);
              }}
            />
            <Button label="Keep card" variant="ghost" fullWidth onPress={() => setSheet(null)} />
          </View>
        )}
      </BottomSheet>
      <ConfirmSheet
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        subtitle={
          confirming === 'terminate'
            ? `Terminate the card ending ${card.last4}`
            : `Replace the card ending ${card.last4}`
        }
        error={error}
        onApproved={run}
      />
    </View>
  );
}
