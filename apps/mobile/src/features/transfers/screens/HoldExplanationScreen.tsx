import { useLocalSearchParams, useRouter } from 'expo-router';
import { Gauge, LifeBuoy, ShieldCheck, ShieldOff, type LucideIcon } from '@/components/icons';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AIBadge,
  Button,
  Card,
  Divider,
  ErrorState,
  Icon,
  ListItem,
  MoneyText,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
  type RiskReason,
  type TextColor,
} from '@/components';
import { fromApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { SendHeader } from '../components/SendHeader';
import { StepUpSheet } from '../components/StepUpSheet';
import { canCancel, outcomeOf, riskReasonsOf, sendErrorMessage } from '../confirm';
import {
  HOLD_TITLE,
  isWaitingOutcome,
  nextSteps,
  reasonHelp,
  riskBand,
  scoreOutOf100,
  type RiskBand,
} from '../hold';
import { useTranslation } from 'react-i18next';

const BAND_COLOR: Record<RiskBand['level'], TextColor> = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
};

function Reason({ reason }: { reason: RiskReason }) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing[1] }} accessible>
      <Text variant="bodyStrong">{reason.label}</Text>
      <Text variant="bodySmall" color="textMuted">
        {reasonHelp(reason.code)}
      </Text>
    </View>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View style={[styles.row, { gap: spacing[3] }]}>
      <View style={[styles.num, { backgroundColor: colors.raised, borderRadius: radius.pill }]}>
        <Text variant="caption">{n}</Text>
      </View>
      <Text variant="bodySmall" style={styles.flex}>
        {text}
      </Text>
    </View>
  );
}

/**
 * "Why was this held?" (AI-1): the fraud checks' decision on one payment, in
 * words. Risk level, each reason and what it means, what happens next, and the
 * ways out: confirm it is you, cancel, or say it was not you.
 */
export function HoldExplanationScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string>();
  const { t: tr } = useTranslation();
  const transfer = useRepoQuery('transfers', 'get', { path: { transfer_id: id } });
  const cancel = useMoneyMutation('transfers', 'cancel');

  const header = <SendHeader title={tr('transfers.holdScreen.title')} />;
  if (!transfer.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {transfer.isError ? (
          <ErrorState title={tr('common.paymentFailed')} onRetry={() => transfer.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel={tr('transfers.holdScreen.loading')}>
            <Skeleton height={28} width={220} />
            <Skeleton height={96} />
            <Skeleton height={140} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const t = transfer.data;
  const outcome = outcomeOf(t);
  const toResult = () => router.replace({ pathname: '/send/result/[id]', params: { id: t.id } });

  if (!isWaitingOutcome(outcome)) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <View style={[styles.row, { gap: spacing[2] }]}>
          <Icon icon={ShieldCheck} color="success" />
          <Text variant="h3" style={styles.flex}>
            {tr('transfers.holdScreen.nothing')}
          </Text>
        </View>
        <Text color="textMuted">{tr('transfers.holdScreen.passed')}</Text>
        <Button label={tr('transfers.holdScreen.see')} onPress={toResult} />
      </Screen>
    );
  }

  const risk = t.risk;
  const band = risk ? riskBand(risk.score) : null;
  const reasons = riskReasonsOf(t);
  // A cooling-off wait comes from the new-beneficiary rule, not the risk score.
  if (outcome === 'delayed' && reasons.length === 0) {
    reasons.push({
      code: 'new_beneficiary',
      label: tr('transfers.holdScreen.firstLarge'),
      severity: 'medium',
    });
  }

  const cancelIt = () => {
    setError(undefined);
    cancel.mutate(
      { path: { transfer_id: t.id } },
      { onSuccess: toResult, onError: (e) => setError(sendErrorMessage(e).message) },
    );
  };

  const ways: { title: string; subtitle: string; icon: LucideIcon; go: () => void }[] = [
    {
      title: tr('transfers.holdScreen.notMe'),
      subtitle: tr('transfers.holdScreen.notMeHint'),
      icon: ShieldOff,
      go: () => router.push('/security/panic'),
    },
    {
      title: tr('transfers.holdScreen.talk'),
      subtitle: tr('transfers.holdScreen.talkHint'),
      icon: LifeBuoy,
      go: () => router.push('/support'),
    },
  ];

  return (
    <Screen
      header={header}
      edges={['top', 'bottom']}
      footer={
        <View style={{ gap: spacing[2] }}>
          {error && (
            <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
              {error}
            </Text>
          )}
          {(outcome === 'step_up' || outcome === 'delayed') && (
            <Button
              label={
                outcome === 'delayed'
                  ? tr('transfers.holdScreen.sendNow')
                  : tr('transfers.holdScreen.confirmMe')
              }
              onPress={() => setChecking(true)}
            />
          )}
          {canCancel(t.status) && (
            <Button
              label={tr('transfers.holdScreen.cancel')}
              variant="secondary"
              loading={cancel.isPending}
              onPress={cancelIt}
            />
          )}
        </View>
      }
    >
      <View style={{ gap: spacing[1] }}>
        <Text variant="title" accessibilityRole="header">
          {HOLD_TITLE[outcome]}
        </Text>
        <View style={[styles.row, styles.wrap, { gap: spacing[1] }]}>
          <MoneyText
            value={fromApiMoney(t.amount)}
            variant="bodyStrong"
            label={tr('common.amount')}
          />
          <Text color="textMuted">{tr('transfers.holdScreen.to', { name: t.recipient.name })}</Text>
        </View>
      </View>

      {risk && band && (
        <Card>
          <View style={{ gap: spacing[2] }}>
            <View
              accessible
              accessibilityLabel={tr('transfers.holdScreen.score', {
                band: band.label,
                score: scoreOutOf100(risk.score),
              })}
              style={[styles.row, { gap: spacing[2] }]}
            >
              <Icon icon={Gauge} color={BAND_COLOR[band.level]} />
              <Text variant="h3" style={styles.flex}>
                {band.label}
              </Text>
              <Text variant="bodySmall" color="textMuted">
                {tr('transfers.holdScreen.scoreShort', { score: scoreOutOf100(risk.score) })}
              </Text>
            </View>
            <View style={styles.start}>
              <AIBadge
                feature={tr('transfers.holdScreen.feature')}
                explanation={tr('transfers.holdScreen.checkedBy', {
                  explanation: tr('transfers.holdScreen.explanation'),
                  model: risk.model_version,
                })}
                fallback={tr('transfers.holdScreen.fallback')}
                onManage={() =>
                  router.push({ pathname: '/ai/[feature]', params: { feature: 'fraud' } })
                }
              />
            </View>
          </View>
        </Card>
      )}

      <SectionHeader title={tr('transfers.holdScreen.noticed')} />
      <Card>
        <View style={{ gap: spacing[4] }}>
          {reasons.map((r) => (
            <Reason key={r.code} reason={r} />
          ))}
        </View>
      </Card>

      <SectionHeader title={tr('transfers.holdScreen.next')} />
      <Card>
        <View style={{ gap: spacing[3] }}>
          {nextSteps(outcome).map((s, i) => (
            <Step key={s} n={i + 1} text={s} />
          ))}
        </View>
      </Card>

      <Text variant="bodySmall" color="textMuted">
        {tr('transfers.holdScreen.pressure')}
      </Text>

      <Card padded={false}>
        {ways.map((w, i) => (
          <View key={w.title}>
            {i > 0 && <Divider />}
            <ListItem
              title={w.title}
              subtitle={w.subtitle}
              leading={w.icon}
              showChevron
              onPress={w.go}
            />
          </View>
        ))}
      </Card>

      <StepUpSheet
        key={checking ? t.id : 'none'}
        transferId={checking ? t.id : null}
        reason={reasons[0]?.label ?? tr('transfers.holdScreen.oneMore')}
        onClose={() => setChecking(false)}
        onReleased={() => {
          setChecking(false);
          toResult();
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
  flex: { flex: 1 },
  start: { alignSelf: 'flex-start' },
  num: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
});
