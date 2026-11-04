import { useLocalSearchParams } from 'expo-router';
import { FileText } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Card, EmptyState, Screen, Text } from '@/components';
import { formatDate } from '@/features/transactions/format';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useTheme } from '@/theme';

import { legalDocument } from '../documents';

/** Terms of use or the NDPA privacy notice, read in the app's language (SET-6). */
export function LegalDocumentScreen() {
  const { doc: slug } = useLocalSearchParams<{ doc: string }>();
  const { spacing } = useTheme();
  // Subscribing re-renders the document when the language changes.
  const { t } = useTranslation();
  const doc = legalDocument(slug ?? '');

  if (!doc) {
    return (
      <Screen header={<SendHeader title={t('legal.title')} />} edges={['top', 'bottom']}>
        <EmptyState
          icon={FileText}
          title={t('legal.notFound')}
          message={t('legal.notFoundMessage')}
        />
      </Screen>
    );
  }

  return (
    <Screen header={<SendHeader title={doc.title} />} edges={['top', 'bottom']}>
      <View style={{ gap: spacing[1] }}>
        <Text variant="body">{doc.summary}</Text>
        <Text variant="caption" color="textMuted">
          {t('legal.updated', { date: formatDate(doc.updated) })}
        </Text>
      </View>
      <Card>
        <View style={{ gap: spacing[4] }}>
          {doc.sections.map((s, i) => (
            <View key={s.key} style={{ gap: spacing[1] }}>
              <Text variant="bodyStrong" accessibilityRole="header">
                {`${i + 1}. ${s.title}`}
              </Text>
              <Text variant="bodySmall" color="textMuted">
                {s.body}
              </Text>
            </View>
          ))}
        </View>
      </Card>
    </Screen>
  );
}
