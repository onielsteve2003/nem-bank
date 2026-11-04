import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { CircleCheck, CircleX, Clock, Copy, Share2 } from '@/components/icons';
import { Share, StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  ErrorState,
  Icon,
  ListItem,
  Screen,
  Skeleton,
  SkeletonGroup,
  Text,
  useToast,
} from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { categoryMeta, CUSTOMER_LABEL, shortDate } from '../bills';
import { useTranslation } from 'react-i18next';
import i18n, { localized } from '@/lib/i18n';

type Status = Schema<'BillPayment'>['status'];

const HEADLINE = localized<Status>({
  completed: 'bills.receipt.headline.completed',
  processing: 'bills.receipt.headline.processing',
  failed: 'bills.receipt.headline.failed',
  reversed: 'bills.receipt.headline.reversed',
});

/** The text shared with whoever will load the meter. */
export const tokenMessage = (p: Schema<'BillPayment'>) =>
  i18n.t('bills.receipt.tokenMessage', {
    biller: p.biller_name,
    meter: p.customer_id,
    token: p.token,
  }) +
  (p.units ? i18n.t('bills.receipt.tokenUnits', { units: p.units }) : '') +
  i18n.t('bills.receipt.tokenRef', { reference: p.reference });

/** What a bill payment bought, for whom, and how it went (BILL-1, BILL-2). */
export function BillReceiptScreen({ id }: { id: string }) {
  const router = useRouter();
  const { colors, radius, spacing } = useTheme();
  const toast = useToast();
  const { t } = useTranslation();
  const payment = useRepoQuery('bills', 'getPayment', { path: { payment_id: id } });
  const p = payment.data;

  return (
    <Screen
      header={<SendHeader title={t('receipt.title')} />}
      edges={['top', 'bottom']}
      footer={<Button label={t('common.done')} onPress={() => router.dismissTo('/bills')} />}
    >
      {payment.isError ? (
        <ErrorState title={t('bills.receipt.failed')} onRetry={() => payment.refetch()} />
      ) : !p ? (
        <SkeletonGroup accessibilityLabel={t('receipt.loading')}>
          <Skeleton height={120} />
          <Skeleton height={180} />
        </SkeletonGroup>
      ) : (
        <>
          <View style={[styles.hero, { gap: spacing[2] }]} accessibilityRole="header">
            <Icon
              icon={
                p.status === 'completed' ? CircleCheck : p.status === 'processing' ? Clock : CircleX
              }
              size="xl"
              color={
                p.status === 'completed'
                  ? 'success'
                  : p.status === 'processing'
                    ? 'warning'
                    : 'danger'
              }
            />
            <Text variant="h2">{HEADLINE[p.status]}</Text>
            <Text variant="display">{formatMoney(fromApiMoney(p.amount))}</Text>
          </View>
          {p.token && (
            <View
              style={[
                styles.token,
                {
                  backgroundColor: colors.surface,
                  borderRadius: radius.lg,
                  padding: spacing[4],
                  gap: spacing[3],
                },
              ]}
            >
              <Text variant="caption" color="textMuted">
                {t('bills.receipt.token')}
                {p.units ? ` · ${p.units}` : ''}
              </Text>
              <Text
                variant="h2"
                selectable
                accessibilityLabel={t('bills.receipt.tokenLabel', {
                  token: p.token.split('-').join(' '),
                })}
              >
                {p.token}
              </Text>
              <View style={[styles.row, { gap: spacing[2] }]}>
                <Button
                  label={t('common.copy')}
                  variant="secondary"
                  size="sm"
                  icon={Copy}
                  onPress={async () => {
                    await Clipboard.setStringAsync(p.token!.replaceAll('-', ''));
                    toast.show({ message: t('bills.receipt.tokenCopied'), tone: 'success' });
                  }}
                />
                <Button
                  label={t('common.share')}
                  variant="secondary"
                  size="sm"
                  icon={Share2}
                  onPress={() => void Share.share({ message: tokenMessage(p) })}
                />
              </View>
              <Text variant="caption" color="textMuted">
                {t('bills.receipt.keypad')}
              </Text>
            </View>
          )}
          <Card padded={false}>
            <ListItem
              leading={categoryMeta(p.category).icon}
              title={p.biller_name}
              subtitle={p.product_name ?? categoryMeta(p.category).label}
            />
            <ListItem title={CUSTOMER_LABEL[p.category]} subtitle={p.customer_id} />
            <ListItem title={t('common.reference')} subtitle={p.reference} />
            <ListItem title={t('common.date')} subtitle={shortDate(p.created_at)} />
          </Card>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', paddingVertical: 16 },
  token: { alignItems: 'center' },
  row: { flexDirection: 'row' },
});
