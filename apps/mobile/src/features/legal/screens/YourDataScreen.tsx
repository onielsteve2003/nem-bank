import { useRouter } from 'expo-router';
import { Check, CircleCheck, UserX } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Icon, ListItem, Screen, Text, useToast } from '@/components';
import { isApiError } from '@/data';
import { formatDate } from '@/features/transactions/format';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import i18n from '@/lib/i18n';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

/**
 * Your data (SET-5, NDPA 2023): request a copy of everything the bank holds,
 * emailed as JSON, or go on to delete the account.
 */
export function YourDataScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const toast = useToast();
  const me = useRepoQuery('users', 'getMe');
  const exportData = useRepoMutation('privacy', 'requestExport', {
    invalidates: [],
    onError: (e) =>
      toast.show({
        message: isApiError(e) ? e.problem.title : i18n.t('common.somethingWrong'),
        tone: 'error',
      }),
  });
  const email = me.data?.email ?? '';
  const request = exportData.data;
  const includes: string[] = t('yourData.export.includes', { returnObjects: true });

  return (
    <Screen header={<SendHeader title={t('yourData.title')} />} edges={['top', 'bottom']}>
      <Text variant="bodySmall" color="textMuted">
        {t('yourData.intro')}
      </Text>

      <Card>
        <View style={{ gap: spacing[3] }}>
          <Text variant="bodyStrong" accessibilityRole="header">
            {t('yourData.export.title')}
          </Text>
          <Text variant="bodySmall" color="textMuted">
            {t('yourData.export.body', { email })}
          </Text>
          <View style={{ gap: spacing[2] }}>
            {includes.map((item) => (
              <View key={item} style={[styles.row, { gap: spacing[2] }]}>
                <Icon icon={Check} size="sm" color="textMuted" />
                <Text variant="bodySmall" style={styles.flex}>
                  {item}
                </Text>
              </View>
            ))}
          </View>
          {request ? (
            <View style={[styles.row, { gap: spacing[2] }]} accessibilityLiveRegion="polite">
              <Icon icon={CircleCheck} color="success" />
              <View style={styles.flex}>
                <Text variant="bodyStrong">
                  {t('yourData.export.received', { date: formatDate(request.requested_at) })}
                </Text>
                <Text variant="bodySmall" color="textMuted">
                  {t('yourData.export.receivedBody', {
                    email,
                    date: formatDate(request.completes_by),
                  })}
                </Text>
              </View>
            </View>
          ) : (
            <Button
              label={t('yourData.export.request')}
              variant="secondary"
              fullWidth
              loading={exportData.isPending}
              disabled={!me.data}
              onPress={() => exportData.mutate({})}
            />
          )}
        </View>
      </Card>

      <Card padded={false}>
        <ListItem
          title={t('yourData.delete.row')}
          subtitle={t('yourData.delete.rowHint')}
          leading={UserX}
          onPress={() => router.push('/settings/delete-account')}
        />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  flex: { flex: 1 },
});
