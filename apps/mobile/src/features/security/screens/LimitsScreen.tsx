import { formatMoney } from '@nem/shared';
import { CalendarClock, Gauge, Send } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  Button,
  Card,
  Divider,
  ErrorState,
  Icon,
  ListItem,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
  useToast,
} from '@/components';
import { isApiError } from '@/data';
import i18n from '@/lib/i18n';
import {
  StepUpCancelled,
  StepUpNeedsPin,
  useStepUp,
  type StepUpProof,
} from '@/features/cards/hooks/useStepUp';
import { formatDateTime } from '@/features/transactions/format';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { LimitSheet } from '../components/LimitSheet';
import { limitChange, type Limit } from '../security';

const message = (e: unknown) =>
  isApiError(e)
    ? e.problem.code === 'offline'
      ? i18n.t('common.offline')
      : (e.problem.detail ?? e.problem.title)
    : i18n.t('security.limits.saveFailed');

const shown = (l: Limit) =>
  l ? formatMoney(l, { trimZeroMinor: true }) : i18n.t('common.noLimit');
const toApi = (l: Limit) => (l ? toApiMoney(l) : null);

/**
 * Self-set limits (SEC-3): a daily and a single-transfer limit under the KYC
 * cap. Lowering applies at once; raising needs a PIN and waits 24 hours.
 */
export function LimitsScreen() {
  const toast = useToast();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const stepUp = useStepUp();
  const q = useRepoQuery('security', 'getLimits');
  const set = useRepoMutation('security', 'setLimits');
  const [editing, setEditing] = useState<'daily' | 'single' | null>(null);
  const [raise, setRaise] = useState<{ daily: Limit; single: Limit } | null>(null);
  const [stepUpError, setStepUpError] = useState<string>();
  const limits = q.data;

  if (!limits) {
    return (
      <Screen header={<SendHeader title={t('security.limits.title')} />} edges={['top', 'bottom']}>
        {q.isError ? (
          <ErrorState title={t('security.limits.failed')} onRetry={() => q.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel={t('security.limits.loading')}>
            <Skeleton height={120} />
            <Skeleton height={140} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const daily = limits.daily_limit ? fromApiMoney(limits.daily_limit) : null;
  const single = limits.single_limit ? fromApiMoney(limits.single_limit) : null;
  const cap = fromApiMoney(limits.kyc_daily_cap);
  const pending = limits.pending_increase;

  const save = (next: { daily: Limit; single: Limit }) => {
    const loosens =
      limitChange(daily, next.daily) === 'raise' || limitChange(single, next.single) === 'raise';
    if (loosens) {
      setStepUpError(undefined);
      setEditing(null);
      setRaise(next);
      return;
    }
    set.mutate(
      { body: { daily_limit: toApi(next.daily), single_limit: toApi(next.single) } },
      {
        onSuccess: () => {
          setEditing(null);
          toast.show({ message: t('security.limits.lowered'), tone: 'success' });
        },
        onError: (e) => toast.show({ message: message(e), tone: 'error' }),
      },
    );
  };

  const raiseWith = async (proof: StepUpProof) => {
    if (!raise) return false;
    try {
      const stepUpToken = await stepUp('limit_increase', 'self_limits', proof);
      const result = await set.mutateAsync({
        body: { daily_limit: toApi(raise.daily), single_limit: toApi(raise.single) },
        stepUpToken,
      });
      setRaise(null);
      const at = result.pending_increase?.effective_at;
      toast.show({
        message: at
          ? t('security.limits.startsAt', { when: formatDateTime(at) })
          : t('security.limits.saved'),
        tone: 'success',
      });
      return true;
    } catch (e) {
      if (e instanceof StepUpCancelled) return false;
      setStepUpError(e instanceof StepUpNeedsPin ? t('common.faceIdUsePin') : message(e));
      return false;
    }
  };

  const keepCurrent = () =>
    set.mutate(
      { body: { daily_limit: toApi(daily), single_limit: toApi(single) } },
      {
        onSuccess: () => toast.show({ message: t('security.limits.cancelled'), tone: 'success' }),
        onError: (e) => toast.show({ message: message(e), tone: 'error' }),
      },
    );

  return (
    <Screen
      header={<SendHeader title={t('security.limits.title')} />}
      edges={['top', 'bottom']}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      <Card>
        <View style={{ gap: spacing[1] }}>
          <Text variant="bodySmall" color="textMuted">
            {t('security.limits.cap')}
          </Text>
          <Text variant="h2">
            {t('security.limits.capPerDay', { amount: formatMoney(cap, { trimZeroMinor: true }) })}
          </Text>
          <Text variant="bodySmall" color="textMuted">
            {t('security.limits.capHelp')}
          </Text>
        </View>
      </Card>
      {pending && (
        <Card>
          <View style={{ gap: spacing[3] }}>
            <View style={{ flexDirection: 'row', gap: spacing[2], alignItems: 'center' }}>
              <Icon
                icon={CalendarClock}
                color="warning"
                accessibilityLabel={t('security.limits.waiting')}
              />
              <Text variant="bodyStrong">
                {t('security.limits.higherFrom', { when: formatDateTime(pending.effective_at) })}
              </Text>
            </View>
            <Text variant="bodySmall" color="textMuted">
              {t('security.limits.pending', {
                daily: shown(pending.daily_limit && fromApiMoney(pending.daily_limit)),
                single: shown(pending.single_limit && fromApiMoney(pending.single_limit)),
              })}
            </Text>
            <Button
              label={t('security.limits.keep')}
              variant="secondary"
              size="sm"
              loading={set.isPending}
              onPress={keepCurrent}
            />
          </View>
        </Card>
      )}
      <View style={{ gap: spacing[2] }}>
        <SectionHeader title={t('security.limits.title')} />
        <Card padded={false}>
          <ListItem
            title={t('security.limits.daily')}
            subtitle={t(daily ? 'security.limits.dailyHelp' : 'security.limits.dailyUnset')}
            leading={Gauge}
            trailing={shown(daily)}
            onPress={() => setEditing('daily')}
            accessibilityLabel={t('security.limits.dailyLabel', { amount: shown(daily) })}
          />
          <Divider />
          <ListItem
            title={t('security.limits.single')}
            subtitle={t(single ? 'security.limits.singleHelp' : 'security.limits.singleUnset')}
            leading={Send}
            trailing={shown(single)}
            onPress={() => setEditing('single')}
            accessibilityLabel={t('security.limits.singleLabel', { amount: shown(single) })}
          />
        </Card>
      </View>
      {editing && (
        <LimitSheet
          which={editing}
          daily={daily}
          single={single}
          cap={cap}
          saving={set.isPending}
          onClose={() => setEditing(null)}
          onSave={(next) =>
            save(editing === 'daily' ? { daily: next, single } : { daily, single: next })
          }
        />
      )}
      <ConfirmSheet
        open={raise !== null}
        onClose={() => setRaise(null)}
        subtitle={t('security.limits.raiseStep')}
        error={stepUpError}
        onApproved={(pin) => (pin ? raiseWith({ pin }) : Promise.resolve(false))}
        approveWithBiometrics={(label) => raiseWith({ biometric: label })}
      />
    </Screen>
  );
}
