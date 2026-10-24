import type { Schema } from '@nem/contracts';
import { Gauge, Store } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { ListItem, SectionHeader, Switch, useToast } from '@/components';
import { isApiError, type ApiError } from '@/data';
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
  e.problem.code === 'offline'
    ? "You're offline. Reconnect and try again."
    : (e.problem.detail ?? e.problem.title);

/**
 * What a card may do (CARD-4): freeze, online and international payments, a
 * spend limit and a merchant lock. Each change saves at once. A card frozen by
 * panic mode stays frozen while panic is on, and needs a fresh check after.
 */
export function CardControls({ card }: Props) {
  const { spacing } = useTheme();
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
      freeze.mutate({ path }, { onSuccess: () => toast.show({ message: 'Card frozen' }) });
      return;
    }
    unfreeze.mutate(
      { path },
      {
        onSuccess: () => toast.show({ message: 'Card unfrozen', tone: 'success' }),
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
          ? 'Face ID isn’t set up for this here. Enter your PIN.'
          : isApiError(e)
            ? message(e)
            : 'We couldn’t unfreeze the card. Try again.',
      );
      return false;
    }
    setSheet(null);
    toast.show({ message: 'Card unfrozen', tone: 'success' });
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
        <SectionHeader title="Controls" />
        <Switch
          label="Freeze card"
          description={
            card.frozen_by_panic
              ? 'Panic mode froze this card. Turning panic mode off unfreezes it.'
              : 'Declines every new payment until you unfreeze it.'
          }
          value={frozen}
          disabled={busy}
          onValueChange={setFrozen}
        />
        <Switch
          label="Online payments"
          description="Websites and apps"
          value={card.controls.online_enabled}
          disabled={update.isPending}
          onValueChange={(v) =>
            save({ online_enabled: v }, v ? 'Online payments on' : 'Online payments off')
          }
        />
        <Switch
          label="International payments"
          description="Merchants outside Nigeria"
          value={card.controls.international_enabled}
          disabled={update.isPending}
          onValueChange={(v) =>
            save(
              { international_enabled: v },
              v ? 'International payments on' : 'International payments off',
            )
          }
        />
      </View>
      <ListItem
        leading={Gauge}
        title="Spend limit"
        subtitle={limitSummary(card)}
        onPress={() => setSheet('limit')}
      />
      <ListItem
        leading={Store}
        title="Merchant lock"
        subtitle={lock ? `Only ${lock.merchant_name}` : 'Any merchant'}
        onPress={() => setSheet('lock')}
      />

      {sheet === 'limit' && (
        <SpendLimitSheet
          card={card}
          open
          onClose={() => setSheet(null)}
          saving={update.isPending}
          onSave={(limit) =>
            save({ spend_limit: limit }, limit ? 'Spend limit saved' : 'Spend limit removed')
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
              next ? `Locked to ${next.merchant_name}` : 'Merchant lock removed',
            )
          }
        />
      )}
      <ConfirmSheet
        open={sheet === 'unfreeze'}
        onClose={() => setSheet(null)}
        subtitle={`Unfreeze the card ending ${card.last4}`}
        error={stepUpError}
        onApproved={(pin) => (pin ? unfreezeWith({ pin }) : Promise.resolve(false))}
        approveWithBiometrics={(label) => unfreezeWith({ biometric: label })}
      />
    </View>
  );
}
