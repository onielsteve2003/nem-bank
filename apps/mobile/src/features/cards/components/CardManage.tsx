import type { Schema } from '@nem/contracts';
import { RefreshCw, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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

/**
 * Closing a card (CARD-6): replace it with a new number when it may have
 * leaked, or terminate it for good. Both say what happens first, then need the
 * PIN or Face ID. Each is one idempotent request, so a retry never makes two.
 */
export function CardManage({ card, onReplaced }: Props) {
  const { spacing } = useTheme();
  const { t } = useTranslation();
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
        toast.show({
          message: t('cards.manage.replace.done', { last4: next.last4 }),
          tone: 'success',
        });
        onReplaced?.(next);
      } else {
        await terminate.mutateAsync({ path });
        toast.show({ message: t('cards.manage.terminate.done', { last4: card.last4 }) });
      }
      haptic('success');
      setConfirming(null);
      return true;
    } catch (e) {
      setError(
        isApiError(e)
          ? e.problem.code === 'offline'
            ? t('common.offline')
            : (e.problem.detail ?? e.problem.title)
          : t('cards.manage.failed'),
      );
      return false;
    }
  };

  const copy = sheet
    ? {
        title: t(`cards.manage.${sheet}.title`),
        points: t(`cards.manage.${sheet}.points`, { returnObjects: true }),
        confirm: t(`cards.manage.${sheet}.confirm`),
      }
    : null;

  return (
    <View>
      <View style={{ paddingHorizontal: spacing[2] }}>
        <SectionHeader title={t('cards.manage.title')} />
      </View>
      <ListItem
        leading={RefreshCw}
        title={t('cards.manage.replace.confirm')}
        subtitle={t('cards.manage.replace.subtitle')}
        onPress={() => setSheet('replace')}
      />
      <ListItem
        leading={Trash2}
        title={t('cards.manage.terminate.confirm')}
        subtitle={t('cards.manage.terminate.subtitle')}
        onPress={() => setSheet('terminate')}
      />

      <BottomSheet open={sheet !== null} onClose={() => setSheet(null)} title={copy?.title}>
        {copy && sheet && (
          <View style={{ gap: spacing[4] }}>
            <Text color="textMuted">
              {t('cards.nameEnds', { name: cardName(card), last4: card.last4 })}
            </Text>
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
            <Button
              label={t('cards.manage.keep')}
              variant="ghost"
              fullWidth
              onPress={() => setSheet(null)}
            />
          </View>
        )}
      </BottomSheet>
      <ConfirmSheet
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        subtitle={
          confirming === 'terminate'
            ? t('cards.manage.terminate.step', { last4: card.last4 })
            : t('cards.manage.replace.step', { last4: card.last4 })
        }
        error={error}
        onApproved={run}
      />
    </View>
  );
}
