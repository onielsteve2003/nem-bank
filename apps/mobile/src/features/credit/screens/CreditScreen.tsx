import { useRouter } from 'expo-router';
import { HandCoins, RefreshCw, ShieldCheck } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import {
  AIBadge,
  Button,
  Card,
  DemoMoneyBadge,
  ErrorState,
  Icon,
  MoneyText,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
  TONE_PALETTE,
} from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { usePreferencesStore } from '@/stores';
import { useTheme } from '@/theme';

import { bandIndex, IMPACT, nextStep, SCORE_BANDS, sortReasons } from '../credit';

const checkedFormat = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

const STANDARD_RULES =
  'Standard rules: salary paid into Nem in the last three months, KYC Tier 3 and no loan still being repaid.';

/**
 * Credit hub (CRD-1): whether the customer can borrow, up to how much, their
 * score band, and every reason behind the decision. Credit always explains
 * itself; with AI scoring off the same check runs on the standard rules.
 */
export function CreditScreen() {
  const router = useRouter();
  const { colors, radius, spacing } = useTheme();
  const aiOn = usePreferencesStore((s) => s.ai.creditScoring);
  const check = useRepoQuery('credit', 'getEligibility');
  const e = check.data;

  let body;
  if (check.isError) {
    body = (
      <ErrorState title="We couldn't check what you can borrow" onRetry={() => check.refetch()} />
    );
  } else if (!e) {
    body = (
      <SkeletonGroup accessibilityLabel="Checking what you can borrow">
        <Skeleton height={200} />
        <Skeleton height={160} />
      </SkeletonGroup>
    );
  } else {
    const band = bandIndex(e.score_band);
    const step = e.eligible ? null : nextStep(e.reasons);
    body = (
      <>
        <Card>
          <View style={{ gap: spacing[4] }}>
            <View style={[styles.row, { gap: spacing[2] }]}>
              {aiOn ? (
                <AIBadge
                  feature="Credit scoring"
                  explanation={e.ai.explanation}
                  fallback={STANDARD_RULES}
                />
              ) : (
                <Text variant="caption" color="textMuted">
                  AI scoring is off · standard check
                </Text>
              )}
            </View>
            <View style={{ gap: spacing[1] }}>
              <Text variant="bodySmall" color="textMuted">
                {e.eligible ? 'You can borrow up to' : 'You can’t borrow yet'}
              </Text>
              {e.eligible ? (
                <MoneyText
                  value={fromApiMoney(e.max_amount)}
                  variant="amountLarge"
                  trimZeroMinor
                  label="You can borrow up to"
                />
              ) : (
                <Text variant="h2">Here’s why, and what to do</Text>
              )}
            </View>

            <View
              style={{ gap: spacing[2] }}
              accessible
              accessibilityLabel={`Credit score band: ${SCORE_BANDS[band]?.label ?? e.score_band}, ${band + 1} of 4`}
            >
              <View style={[styles.row, { gap: spacing[1] }]}>
                {SCORE_BANDS.map((b, i) => (
                  <View
                    key={b.value}
                    style={[
                      styles.segment,
                      {
                        borderRadius: radius.pill,
                        backgroundColor:
                          i <= band
                            ? colors[TONE_PALETTE[SCORE_BANDS[band]!.tone].fill]
                            : colors.border,
                      },
                    ]}
                  />
                ))}
              </View>
              <View style={[styles.row, styles.between]}>
                <Text variant="bodyStrong">{SCORE_BANDS[band]?.label} score</Text>
                <Text variant="caption" color="textMuted">
                  Checked {checkedFormat.format(new Date(e.checked_at))}
                </Text>
              </View>
            </View>

            <Button
              label="Check again"
              icon={RefreshCw}
              variant="ghost"
              loading={check.isRefetching}
              onPress={() => void check.refetch()}
            />
          </View>
        </Card>

        <View style={{ gap: spacing[2] }}>
          <SectionHeader title="Why" />
          <Card>
            <View style={{ gap: spacing[3] }} accessibilityRole="list">
              {sortReasons(e.reasons).map((r) => {
                const impact = IMPACT[r.impact];
                return (
                  <View
                    key={r.code}
                    style={[styles.row, { gap: spacing[3] }]}
                    accessible
                    accessibilityLabel={`${impact.label}: ${r.message}`}
                  >
                    <Icon icon={impact.icon} color={impact.color} />
                    <Text variant="body" style={styles.flex}>
                      {r.message}
                    </Text>
                  </View>
                );
              })}
            </View>
          </Card>
        </View>

        {step === 'kyc' && (
          <Button
            label="Verify your identity"
            icon={ShieldCheck}
            onPress={() => router.push('/kyc')}
          />
        )}
        {step === 'repay' && (
          <Text variant="bodySmall" color="textMuted">
            Once your current loan is repaid, check again to borrow.
          </Text>
        )}
        {step === 'income' && (
          <Text variant="bodySmall" color="textMuted">
            Have your salary paid into your Nem account. After it arrives, check again.
          </Text>
        )}
        {e.eligible && (
          <>
            <Button
              label="See your offer"
              icon={HandCoins}
              onPress={() => router.push('/credit/offer')}
            />
            <Text variant="bodySmall" color="textMuted">
              Rates start at 24% a year. Nothing is borrowed until you accept an offer.
            </Text>
          </>
        )}
      </>
    );
  }

  return (
    <Screen
      header={<SendHeader title="Credit" first />}
      edges={['top', 'bottom']}
      onRefresh={() => void check.refetch()}
      refreshing={check.isRefetching}
    >
      <View style={styles.start}>
        <DemoMoneyBadge />
      </View>
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  between: { justifyContent: 'space-between' },
  segment: { flex: 1, height: 8 },
  flex: { flex: 1 },
  start: { alignItems: 'flex-start' },
});
