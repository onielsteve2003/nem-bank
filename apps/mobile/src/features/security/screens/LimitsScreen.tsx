import { formatMoney } from '@nem/shared';
import { CalendarClock, Gauge, Send } from 'lucide-react-native';
import { useState } from 'react';
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
      ? "You're offline. Reconnect and try again."
      : (e.problem.detail ?? e.problem.title)
    : 'We couldn’t save your limit. Try again.';

const shown = (l: Limit) => (l ? formatMoney(l, { trimZeroMinor: true }) : 'No limit');
const toApi = (l: Limit) => (l ? toApiMoney(l) : null);

/**
 * Self-set limits (SEC-3): a daily and a single-transfer limit under the KYC
 * cap. Lowering applies at once; raising needs a PIN and waits 24 hours.
 */
export function LimitsScreen() {
  const toast = useToast();
  const { spacing } = useTheme();
  const stepUp = useStepUp();
  const q = useRepoQuery('security', 'getLimits');
  const set = useRepoMutation('security', 'setLimits');
  const [editing, setEditing] = useState<'daily' | 'single' | null>(null);
  const [raise, setRaise] = useState<{ daily: Limit; single: Limit } | null>(null);
  const [stepUpError, setStepUpError] = useState<string>();
  const limits = q.data;

  if (!limits) {
    return (
      <Screen header={<SendHeader title="Your limits" />} edges={['top', 'bottom']}>
        {q.isError ? (
          <ErrorState title="We couldn't load your limits" onRetry={() => q.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel="Loading your limits">
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
          toast.show({ message: 'Limit lowered. It applies now.', tone: 'success' });
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
        message: at ? `Your new limit starts ${formatDateTime(at)}` : 'Limit saved',
        tone: 'success',
      });
      return true;
    } catch (e) {
      if (e instanceof StepUpCancelled) return false;
      setStepUpError(
        e instanceof StepUpNeedsPin
          ? 'Face ID isn’t set up for this here. Enter your PIN.'
          : message(e),
      );
      return false;
    }
  };

  const keepCurrent = () =>
    set.mutate(
      { body: { daily_limit: toApi(daily), single_limit: toApi(single) } },
      {
        onSuccess: () => toast.show({ message: 'Increase cancelled', tone: 'success' }),
        onError: (e) => toast.show({ message: message(e), tone: 'error' }),
      },
    );

  return (
    <Screen
      header={<SendHeader title="Your limits" />}
      edges={['top', 'bottom']}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      <Card>
        <View style={{ gap: spacing[1] }}>
          <Text variant="bodySmall" color="textMuted">
            Your KYC cap
          </Text>
          <Text variant="h2">{`${formatMoney(cap, { trimZeroMinor: true })} a day`}</Text>
          <Text variant="bodySmall" color="textMuted">
            Set your own limits below it. If someone gets into your account, they can’t send more
            than you allow.
          </Text>
        </View>
      </Card>
      {pending && (
        <Card>
          <View style={{ gap: spacing[3] }}>
            <View style={{ flexDirection: 'row', gap: spacing[2], alignItems: 'center' }}>
              <Icon icon={CalendarClock} color="warning" accessibilityLabel="Waiting" />
              <Text variant="bodyStrong">{`Higher limits start ${formatDateTime(pending.effective_at)}`}</Text>
            </View>
            <Text variant="bodySmall" color="textMuted">
              {`Daily: ${shown(pending.daily_limit && fromApiMoney(pending.daily_limit))}. Single transfer: ${shown(pending.single_limit && fromApiMoney(pending.single_limit))}. Until then your current limits apply. Lowering a limit cancels this.`}
            </Text>
            <Button
              label="Keep my current limits"
              variant="secondary"
              size="sm"
              loading={set.isPending}
              onPress={keepCurrent}
            />
          </View>
        </Card>
      )}
      <View style={{ gap: spacing[2] }}>
        <SectionHeader title="Your limits" />
        <Card padded={false}>
          <ListItem
            title="Daily limit"
            subtitle={daily ? 'Total you can send in a day' : 'Not set: your KYC cap applies'}
            leading={Gauge}
            trailing={shown(daily)}
            onPress={() => setEditing('daily')}
            accessibilityLabel={`Daily limit, ${shown(daily)}. Change`}
          />
          <Divider />
          <ListItem
            title="Single transfer"
            subtitle={single ? 'Most you can send at once' : 'Not set'}
            leading={Send}
            trailing={shown(single)}
            onPress={() => setEditing('single')}
            accessibilityLabel={`Single transfer limit, ${shown(single)}. Change`}
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
        subtitle="Raise your limit. It starts in 24 hours."
        error={stepUpError}
        onApproved={(pin) => (pin ? raiseWith({ pin }) : Promise.resolve(false))}
        approveWithBiometrics={(label) => raiseWith({ biometric: label })}
      />
    </Screen>
  );
}
