import type { Schema } from '@nem/contracts';
import { CURRENCIES } from '@nem/shared';
import { useRouter } from 'expo-router';
import { CircleHelp, FileText, Share2, TriangleAlert } from '@/components/icons';
import { Share, StyleSheet, View } from 'react-native';

import { Badge, BottomSheet, Button, Icon, Text, useToast } from '@/components';
import { useTheme } from '@/theme';

import { ReceivingDetailsCard } from './ReceivingDetailsCard';
import { shareMessage } from './receivingDetails';
import { useTranslation } from 'react-i18next';

/**
 * How to pay into a wallet from another bank (ACC-1, ACC-2): each detail with
 * its own copy button, and one Share for the lot. Details the demo bank made
 * up say so in a badge and a line under them, so nobody sends real money to a
 * number that goes nowhere.
 */
export function AccountDetailsSheet({
  account,
  onClose,
  onAddDemoMoney,
}: {
  account: Schema<'Account'> | null;
  onClose: () => void;
  /** Mock bank only: Demo Controls can put money in straight away. */
  onAddDemoMoney?: () => void;
}) {
  const { spacing } = useTheme();
  const toast = useToast();
  const router = useRouter();
  const { t } = useTranslation();
  const details = account?.receiving_details;
  const currency = account ? CURRENCIES[account.currency] : null;

  const share = async () => {
    if (!details || !currency) return;
    try {
      await Share.share({ message: shareMessage(details, currency.name) });
    } catch {
      toast.show({
        message: t('accounts.details.shareFailed'),
        tone: 'error',
      });
    }
  };

  return (
    <BottomSheet
      open={account !== null}
      onClose={onClose}
      title={
        currency
          ? t('accounts.details.title', { flag: currency.flag, name: currency.name })
          : undefined
      }
    >
      {details && currency && (
        <View style={{ gap: spacing[4] }}>
          <View style={[styles.row, { gap: spacing[2] }]}>
            <Text color="textMuted" style={styles.flex}>
              {account?.currency === 'NGN'
                ? t('accounts.details.ngnIntro')
                : t('accounts.details.foreignIntro', { code: currency.code })}
            </Text>
            {details.demo && <Badge label={t('accounts.details.demoBadge')} tone="warning" />}
          </View>

          <ReceivingDetailsCard details={details} />

          {details.demo && (
            <View style={[styles.row, { gap: spacing[2] }]}>
              <Icon icon={TriangleAlert} size="sm" color="warning" />
              <Text variant="caption" color="textMuted" style={styles.flex}>
                {t('accounts.details.demoWarning')}
              </Text>
            </View>
          )}

          <View style={{ gap: spacing[2] }}>
            <Button
              label={t('accounts.details.share')}
              icon={Share2}
              fullWidth
              onPress={() => void share()}
            />
            {account?.currency !== 'NGN' && (
              <Button
                label={t('accounts.details.howReceiving')}
                icon={CircleHelp}
                variant="ghost"
                fullWidth
                onPress={() => {
                  onClose();
                  router.push({
                    pathname: '/convert/receive',
                    params: { currency: account!.currency, entry: 'wallet' },
                  });
                }}
              />
            )}
            <Button
              label={t('accounts.details.statement')}
              icon={FileText}
              variant="ghost"
              fullWidth
              onPress={() => {
                onClose();
                router.push({ pathname: '/statements', params: { account: account!.id } });
              }}
            />
            {onAddDemoMoney && (
              <Button
                label={t('accounts.details.addDemoMoney')}
                variant="ghost"
                fullWidth
                onPress={onAddDemoMoney}
              />
            )}
          </View>
        </View>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
