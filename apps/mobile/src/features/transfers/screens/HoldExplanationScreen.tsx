import { useLocalSearchParams, useRouter } from 'expo-router';
import { Gauge, LifeBuoy, ShieldCheck, ShieldOff, type LucideIcon } from 'lucide-react-native';
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

const BAND_COLOR: Record<RiskBand['level'], TextColor> = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
};

const EXPLANATION =
  'Every payment is scored by rules (amount, device, who you pay, how often) and a fraud model. Risky ones wait for a check, and you always see why.';
const FALLBACK = 'Rules only. Fraud protection cannot be turned off, because it guards your money.';

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
  const transfer = useRepoQuery('transfers', 'get', { path: { transfer_id: id } });
  const cancel = useMoneyMutation('transfers', 'cancel');

  const header = <SendHeader title="Payment checks" />;
  if (!transfer.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {transfer.isError ? (
          <ErrorState title="We couldn't load this payment" onRetry={() => transfer.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel="Loading the payment checks">
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
            Nothing is holding this payment
          </Text>
        </View>
        <Text color="textMuted">It passed our checks. See where it is now.</Text>
        <Button label="See the payment" onPress={toResult} />
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
      label: 'This is your first large payment to someone new.',
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
      title: "I didn't make this payment",
      subtitle: 'Freeze everything now with the panic button',
      icon: ShieldOff,
      go: () => router.push('/security/panic'),
    },
    {
      title: 'Talk to us',
      subtitle: 'Chat with Nem support about this payment',
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
              label={outcome === 'delayed' ? 'Send now' : 'Confirm it is me'}
              onPress={() => setChecking(true)}
            />
          )}
          {canCancel(t.status) && (
            <Button
              label="Cancel payment"
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
          <MoneyText value={fromApiMoney(t.amount)} variant="bodyStrong" label="Amount" />
          <Text color="textMuted">to {t.recipient.name}</Text>
        </View>
      </View>

      {risk && band && (
        <Card>
          <View style={{ gap: spacing[2] }}>
            <View
              accessible
              accessibilityLabel={`${band.label}, ${scoreOutOf100(risk.score)} out of 100`}
              style={[styles.row, { gap: spacing[2] }]}
            >
              <Icon icon={Gauge} color={BAND_COLOR[band.level]} />
              <Text variant="h3" style={styles.flex}>
                {band.label}
              </Text>
              <Text variant="bodySmall" color="textMuted">
                {scoreOutOf100(risk.score)} / 100
              </Text>
            </View>
            <View style={styles.start}>
              <AIBadge
                feature="Fraud protection"
                explanation={`${EXPLANATION} Checked by ${risk.model_version}.`}
                fallback={FALLBACK}
                onManage={() =>
                  router.push({ pathname: '/ai/[feature]', params: { feature: 'fraud' } })
                }
              />
            </View>
          </View>
        </Card>
      )}

      <SectionHeader title="What we noticed" />
      <Card>
        <View style={{ gap: spacing[4] }}>
          {reasons.map((r) => (
            <Reason key={r.code} reason={r} />
          ))}
        </View>
      </Card>

      <SectionHeader title="What happens next" />
      <Card>
        <View style={{ gap: spacing[3] }}>
          {nextSteps(outcome).map((s, i) => (
            <Step key={s} n={i + 1} text={s} />
          ))}
        </View>
      </Card>

      <Text variant="bodySmall" color="textMuted">
        Did someone call or message you to make this payment? Stop and cancel it. Nem will never ask
        you to move money to keep it safe.
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
        reason={reasons[0]?.label ?? 'This payment needs one more check before it goes.'}
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
