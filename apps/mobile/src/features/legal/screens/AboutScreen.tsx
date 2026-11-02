import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import { Bot, FileText, Info, Package, ShieldCheck } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { Card, Divider, Icon, ListItem, Screen, SectionHeader, Text } from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useTheme } from '@/theme';

import licenses from '../licenses.json';

/** Legal and about (SET-6): version, the demo disclaimer and every legal document. */
export function AboutScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const version = Constants.expoConfig?.version ?? '0.0.0';

  return (
    <Screen header={<SendHeader title={t('legal.title')} />} edges={['top', 'bottom']}>
      <View style={[styles.center, { gap: spacing[1] }]}>
        <Text variant="h2">Nem Bank</Text>
        <Text variant="bodySmall" color="textMuted">
          {t('legal.tagline')}
        </Text>
        <Text variant="caption" color="textMuted">
          {t('legal.version', { version })}
        </Text>
      </View>

      <Card variant="outline">
        <View style={[styles.row, { gap: spacing[3] }]} accessible accessibilityRole="summary">
          <Icon icon={Info} color="warning" />
          <View style={[styles.flex, { gap: spacing[1] }]}>
            <Text variant="bodyStrong">{t('legal.demoTitle')}</Text>
            <Text variant="bodySmall" color="textMuted">
              {t('legal.demo')}
            </Text>
          </View>
        </View>
      </Card>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title={t('legal.documents')} />
        <Card padded={false}>
          <ListItem
            title={t('legal.terms')}
            subtitle={t('legal.termsHint')}
            leading={FileText}
            onPress={() =>
              router.push({ pathname: '/settings/legal/[doc]', params: { doc: 'terms' } })
            }
          />
          <Divider />
          <ListItem
            title={t('legal.privacy')}
            subtitle={t('legal.privacyHint')}
            leading={ShieldCheck}
            onPress={() =>
              router.push({ pathname: '/settings/legal/[doc]', params: { doc: 'privacy' } })
            }
          />
          <Divider />
          <ListItem
            title={t('legal.licenses')}
            subtitle={t('legal.licensesHint', { count: licenses.length })}
            leading={Package}
            onPress={() => router.push('/settings/licenses')}
          />
          <Divider />
          <ListItem
            title={t('legal.modelCards')}
            subtitle={t('legal.modelCardsHint')}
            leading={Bot}
            onPress={() => router.push('/ai')}
          />
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  flex: { flex: 1 },
});
