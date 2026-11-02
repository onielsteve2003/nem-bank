import type { Schema } from '@nem/contracts';
import { Gauge, Store } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ListItem, SectionHeader, Switch, useToast } from '@/components';
import { isApiError, type ApiError } from '@/data';
import i18n from '@/lib/i18n';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { limitSummary } from '../cards';
import { StepUpCancelled, StepUpNeedsPin, useStepUp, type StepUpProof } from '../hooks/useStepUp';
import { MerchantLockSheet } from './MerchantLockSheet';
import { SpendLimitSheet } from './SpendLimitSheet';

type Card = Schema<'Card'>;

export type Props = { card: Card };

const message = (e: ApiError) =>
  e.problem.code === 'offline' ? i18n.t('common.offline') : (e.problem.detail ?? e.problem.title);

/**
 * What a card may do (CARD-4): freeze, online and international payments, a
 * spend limit and a merchant lock. Each change saves at once. A card frozen by
 * panic mode stays frozen while panic is on, and needs a fresh check after.
 */
export function CardControls({ card }: Props) {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const toast = useToast();
  const stepUp = useStepUp();
  const [sheet, setSheet] = useState<'limit' | 'lock' | 'unfreeze' | null>(null);
  const [stepUpError, setStepUpError] = useState<string>();
  const path = { card_id: card.id };
  const onError = (e: ApiError) => toast.show({ message: message(e), tone: 'error' });

  const freeze = useRepoMutation('cards', 'freeze', { onError });
  const unfreeze = useRepoMutation('cards', 'unfreeze');
  const update = useRepoMutation('cards', 'updateControls', { onError });
  const frozen = card.status === 'frozen';
  const busy = freeze.isPending || unfreeze.isPending;

  const setFrozen = (next: boolean) => {
    if (next) {
      freeze.mutate(
        { path },
        { onSuccess: () => toast.show({ message: t('cards.controls.frozen') }) },
      );
      return;
    }
    unfreeze.mutate(
      { path },
      {
        onSuccess: () => toast.show({ message: t('cards.controls.unfrozen'), tone: 'success' }),
        onError: (e) => {
          if (isApiError(e) && e.problem.code === 'step_up_required') {
            setStepUpError(undefined);
            setSheet('unfreeze');
          } else onError(e);
        },
      },
    );
  };

  const unfreezeWith = async (proof: StepUpProof) => {
    try {
      const stepUpToken = await stepUp('unfreeze', card.id, proof);
      await unfreeze.mutateAsync({ path, stepUpToken });
    } catch (e) {
      if (e instanceof StepUpCancelled) return false;
      setStepUpError(
        e instanceof StepUpNeedsPin
          ? t('common.faceIdUsePin')
          : isApiError(e)
            ? message(e)
            : t('cards.controls.unfreezeFailed'),
      );
      return false;
    }
    setSheet(null);
    toast.show({ message: t('cards.controls.unfrozen'), tone: 'success' });
    return true;
  };

  const save = (body: Schema<'UpdateCardRequest'>, done: string) =>
    update.mutate(
      { path, body },
      {
        onSuccess: () => {
          setSheet(null);
          toast.show({ message: done, tone: 'success' });
        },
      },
    );

  const lock = card.controls.merchant_lock;

  return (
    <View style={{ gap: spacing[1] }}>
      <View style={{ paddingHorizontal: spacing[2] }}>
        <SectionHeader title={t('cards.controls.title')} />
        <Switch
          label={t('cards.controls.freeze')}
          description={
            card.frozen_by_panic
              ? t('cards.controls.frozenByPanic')
              : t('cards.controls.freezeHelp')
          }
          value={frozen}
          disabled={busy}
          onValueChange={setFrozen}
        />
        <Switch
          label={t('cards.controls.online')}
          description={t('cards.controls.onlineHelp')}
          value={card.controls.online_enabled}
          disabled={update.isPending}
          onValueChange={(v) =>
            save(
              { online_enabled: v },
              t(v ? 'cards.controls.onlineOn' : 'cards.controls.onlineOff'),
            )
          }
        />
        <Switch
          label={t('cards.controls.international')}
          description={t('cards.controls.internationalHelp')}
          value={card.controls.international_enabled}
          disabled={update.isPending}
          onValueChange={(v) =>
            save(
              { international_enabled: v },
              t(v ? 'cards.controls.internationalOn' : 'cards.controls.internationalOff'),
            )
          }
        />
      </View>
      <ListItem
        leading={Gauge}
        title={t('cards.limit.title')}
        subtitle={limitSummary(card)}
        onPress={() => setSheet('limit')}
      />
      <ListItem
        leading={Store}
        title={t('cards.controls.lockTitle')}
        subtitle={
          lock
            ? t('cards.controls.lockOnly', { merchant: lock.merchant_name })
            : t('cards.controls.anyMerchant')
        }
        onPress={() => setSheet('lock')}
      />

      {sheet === 'limit' && (
        <SpendLimitSheet
          card={card}
          open
          onClose={() => setSheet(null)}
          saving={update.isPending}
          onSave={(limit) =>
            save(
              { spend_limit: limit },
              t(limit ? 'cards.controls.limitSaved' : 'cards.controls.limitRemoved'),
            )
          }
        />
      )}
      {sheet === 'lock' && (
        <MerchantLockSheet
          card={card}
          open
          onClose={() => setSheet(null)}
          saving={update.isPending}
          onSave={(next) =>
            save(
              { merchant_lock: next },
              next
                ? t('cards.controls.lockedTo', { merchant: next.merchant_name })
                : t('cards.controls.lockRemoved'),
            )
          }
        />
      )}
      <ConfirmSheet
        open={sheet === 'unfreeze'}
        onClose={() => setSheet(null)}
        subtitle={t('cards.controls.unfreezeSubtitle', { last4: card.last4 })}
        error={stepUpError}
        onApproved={(pin) => (pin ? unfreezeWith({ pin }) : Promise.resolve(false))}
        approveWithBiometrics={(label) => unfreezeWith({ biometric: label })}
      />
    </View>
  );
}
