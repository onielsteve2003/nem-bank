import { useLocalSearchParams, useRouter } from 'expo-router';
import { MessageCircle } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  ErrorState,
  Screen,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { isApiError } from '@/data';
import { formatDate } from '@/features/transactions/format';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

/** One help article (SUP-2), with a way to ask a person if it didn't answer it. */
export function ArticleScreen() {
  const { slug = '' } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const q = useRepoQuery('support', 'getArticle', { path: { slug } });
  const header = <SendHeader title={t('support.article.title')} />;

  if (!q.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {q.isError ? (
          <ErrorState
            title={
              isApiError(q.error) && q.error.status === 404
                ? t('support.article.moved')
                : t('support.article.failed')
            }
            onRetry={() => q.refetch()}
          />
        ) : (
          <SkeletonGroup accessibilityLabel={t('support.article.loading')}>
            <Skeleton height={32} />
            <Skeleton height={120} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const a = q.data;
  return (
    <Screen
      header={header}
      footer={
        <Button
          label={t('support.article.chat')}
          icon={MessageCircle}
          variant="secondary"
          onPress={() => router.push('/support/new')}
        />
      }
      edges={['top', 'bottom']}
    >
      <View style={{ gap: spacing[2], alignItems: 'flex-start' }}>
        <Badge label={a.category} />
        <Text variant="h2" accessibilityRole="header">
          {a.title}
        </Text>
        <Text variant="caption" color="textMuted">
          {t('support.article.updated', { date: formatDate(a.updated_at) })}
        </Text>
      </View>
      <Card>
        <View style={{ gap: spacing[3] }}>
          {a.body_markdown.split(/\n{2,}/).map((p, i) => (
            <Text key={i} variant="body" selectable>
              {p}
            </Text>
          ))}
        </View>
      </Card>
    </Screen>
  );
}
