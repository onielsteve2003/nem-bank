import { useLocalSearchParams, useRouter } from 'expo-router';
import { MessageCircle } from 'lucide-react-native';
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
  const q = useRepoQuery('support', 'getArticle', { path: { slug } });
  const header = <SendHeader title="Help" />;

  if (!q.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {q.isError ? (
          <ErrorState
            title={
              isApiError(q.error) && q.error.status === 404
                ? 'This article has moved'
                : "We couldn't load this article"
            }
            onRetry={() => q.refetch()}
          />
        ) : (
          <SkeletonGroup accessibilityLabel="Loading the article">
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
          label="Didn’t help? Chat with us"
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
          {`Updated ${formatDate(a.updated_at)}`}
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
