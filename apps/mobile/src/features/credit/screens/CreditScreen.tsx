import { useRouter } from 'expo-router';
import { HandCoins, RefreshCw, ShieldCheck } from '@/components/icons';
import { useTranslation } from 'react-i18next';
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

import { LoanSummary } from '../components/LoanSummary';
import { bandIndex, currentLoan, IMPACT, nextStep, SCORE_BANDS, sortReasons } from '../credit';

const checkedFormat = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * Credit hub (CRD-1): whether the customer can borrow, up to how much, their
 * score band, and every reason behind the decision. Credit always explains
 * itself; with AI scoring off the same check runs on the standard rules.
 */
export function CreditScreen() {
  const router = useRouter();
  const { colors, radius, spacing } = useTheme();
  const { t } = useTranslation();
  const aiOn = usePreferencesStore((s) => s.ai.creditScoring);
  const check = useRepoQuery('credit', 'getEligibility');
  const loans = useRepoQuery('credit', 'listLoans');
  const loan = currentLoan(loans.data?.data ?? []);
  const e = check.data;
  const refresh = () => {
    void check.refetch();
    void loans.refetch();
  };

  let body;
  if (check.isError) {
    body = <ErrorState title={t('credit.hub.failed')} onRetry={() => check.refetch()} />;
  } else if (!e) {
    body = (
      <SkeletonGroup accessibilityLabel={t('credit.hub.loading')}>
        <Skeleton height={200} />
        <Skeleton height={160} />
      </SkeletonGroup>
    );
  } else {
    const band = bandIndex(e.score_band);
    const step = e.eligible ? null : nextStep(e.reasons);
    body = (
      <>
        {loan && (
          <LoanSummary
            loan={loan}
            onPress={() => router.push({ pathname: '/credit/[id]', params: { id: loan.id } })}
          />
        )}
        <Card>
          <View style={{ gap: spacing[4] }}>
            <View style={[styles.row, { gap: spacing[2] }]}>
              {aiOn ? (
                <AIBadge
                  feature={t('credit.hub.aiFeature')}
                  explanation={e.ai.explanation}
                  fallback={t('credit.hub.standardRules')}
                />
              ) : (
                <Text variant="caption" color="textMuted">
                  {t('credit.hub.aiOff')}
                </Text>
              )}
            </View>
            <View style={{ gap: spacing[1] }}>
              <Text variant="bodySmall" color="textMuted">
                {t(e.eligible ? 'credit.hub.canBorrow' : 'credit.hub.cannotBorrow')}
              </Text>
              {e.eligible ? (
                <MoneyText
                  value={fromApiMoney(e.max_amount)}
                  variant="amountLarge"
                  trimZeroMinor
                  label={t('credit.hub.canBorrow')}
                />
              ) : (
                <Text variant="h2">{t('credit.hub.why')}</Text>
              )}
            </View>

            <View
              style={{ gap: spacing[2] }}
              accessible
              accessibilityLabel={t('credit.hub.bandLabel', {
                band: SCORE_BANDS[band]?.label ?? e.score_band,
                position: band + 1,
              })}
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
                <Text variant="bodyStrong">
                  {t('credit.hub.bandScore', { band: SCORE_BANDS[band]?.label })}
                </Text>
                <Text variant="caption" color="textMuted">
                  {t('credit.hub.checked', { when: checkedFormat.format(new Date(e.checked_at)) })}
                </Text>
              </View>
            </View>

            <Button
              label={t('credit.hub.checkAgain')}
              icon={RefreshCw}
              variant="ghost"
              loading={check.isRefetching}
              onPress={() => void check.refetch()}
            />
          </View>
        </Card>

        <View style={{ gap: spacing[2] }}>
          <SectionHeader title={t('credit.hub.whyTitle')} />
          <Card>
            <View style={{ gap: spacing[3] }} accessibilityRole="list">
              {sortReasons(e.reasons).map((r) => {
                const impact = IMPACT[r.impact];
                return (
                  <View
                    key={r.code}
                    style={[styles.row, { gap: spacing[3] }]}
                    accessible
                    accessibilityLabel={t('credit.hub.reason', {
                      impact: impact.label,
                      message: r.message,
                    })}
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
            label={t('credit.hub.verify')}
            icon={ShieldCheck}
            onPress={() => router.push('/kyc')}
          />
        )}
        {step === 'repay' && (
          <Text variant="bodySmall" color="textMuted">
            {t('credit.hub.repayFirst')}
          </Text>
        )}
        {step === 'income' && (
          <Text variant="bodySmall" color="textMuted">
            {t('credit.hub.salary')}
          </Text>
        )}
        {e.eligible && (
          <>
            <Button
              label={t('credit.hub.seeOffer')}
              icon={HandCoins}
              onPress={() => router.push('/credit/offer')}
            />
            <Text variant="bodySmall" color="textMuted">
              {t('credit.hub.rates')}
            </Text>
          </>
        )}
      </>
    );
  }

  return (
    <Screen
      header={<SendHeader title={t('credit.title')} first />}
      edges={['top', 'bottom']}
      onRefresh={refresh}
      refreshing={check.isRefetching || loans.isRefetching}
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
