import type { Schema } from '@nem/contracts';
import { keepPreviousData } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { MessageCircle, Search, SearchX } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Screen,
  Skeleton,
  SkeletonGroup,
  Text,
  TextField,
} from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoQuery } from '@/lib/query';
import { useDebounced } from '@/lib/useDebounced';
import { useTheme } from '@/theme';

type Summary = Schema<'HelpArticleList'>['data'][number];

/** The help center (SUP-2): search every answer, or browse by topic. */
export function HelpScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [category, setCategory] = useState<string>();
  const q = useDebounced(text.trim(), 250);
  // Every article once, for the topic chips.
  const all = useRepoQuery('support', 'searchArticles', {});
  const results = useRepoQuery(
    'support',
    'searchArticles',
    { query: { ...(q ? { q } : {}), ...(category ? { category } : {}) } },
    { placeholderData: keepPreviousData },
  );
  const categories = [...new Set(all.data?.data.map((a) => a.category))].sort();

  const row = (a: Summary) => (
    <Card
      key={a.slug}
      onPress={() => router.push({ pathname: '/support/help/[slug]', params: { slug: a.slug } })}
      accessibilityLabel={t('support.help.rowLabel', { title: a.title, category: a.category })}
    >
      <View style={{ gap: spacing[1] }}>
        <Text variant="caption" color="textMuted">
          {a.category}
        </Text>
        <Text variant="bodyStrong">{a.title}</Text>
        <Text variant="bodySmall" color="textMuted" numberOfLines={2}>
          {a.excerpt}
        </Text>
      </View>
    </Card>
  );

  let body;
  if (!results.data) {
    body = results.isError ? (
      <ErrorState title={t('support.help.failed')} onRetry={() => results.refetch()} />
    ) : (
      <SkeletonGroup accessibilityLabel={t('support.help.loading')}>
        <Skeleton height={88} />
        <Skeleton height={88} />
        <Skeleton height={88} />
      </SkeletonGroup>
    );
  } else if (!results.data.data.length) {
    body = (
      <EmptyState
        icon={SearchX}
        title={t('support.help.noneTitle')}
        message={q ? t('support.help.noneQuery', { q }) : t('support.help.none')}
      />
    );
  } else {
    body = (
      <View style={{ gap: spacing[3] }}>
        <Text variant="caption" color="textMuted" accessibilityLiveRegion="polite">
          {t('support.help.answers', { count: results.data.data.length })}
        </Text>
        {results.data.data.map(row)}
      </View>
    );
  }

  return (
    <Screen
      header={<SendHeader title={t('support.help.title')} />}
      footer={
        <Button
          label={t('support.help.stuck')}
          icon={MessageCircle}
          variant="secondary"
          onPress={() => router.push('/support/new')}
        />
      }
      edges={['top', 'bottom']}
    >
      <TextField
        label={t('support.help.search')}
        value={text}
        onChangeText={setText}
        leadingIcon={Search}
        placeholder={t('support.help.placeholder')}
        returnKeyType="search"
        autoCorrect={false}
        maxLength={100}
      />
      {categories.length > 0 && (
        <View style={[styles.wrap, { gap: spacing[2] }]}>
          <Chip
            label={t('common.all')}
            selected={!category}
            onPress={() => setCategory(undefined)}
          />
          {categories.map((c) => (
            <Chip
              key={c}
              label={c}
              selected={category === c}
              onPress={() => setCategory(category === c ? undefined : c)}
            />
          ))}
        </View>
      )}
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
});
