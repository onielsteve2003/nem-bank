import type { Schema } from '@nem/contracts';
import { keepPreviousData } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { MessageCircle, Search, SearchX } from 'lucide-react-native';
import { useState } from 'react';
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
      accessibilityLabel={`${a.title}, ${a.category}`}
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
      <ErrorState title="We couldn't load help" onRetry={() => results.refetch()} />
    ) : (
      <SkeletonGroup accessibilityLabel="Loading answers">
        <Skeleton height={88} />
        <Skeleton height={88} />
        <Skeleton height={88} />
      </SkeletonGroup>
    );
  } else if (!results.data.data.length) {
    body = (
      <EmptyState
        icon={SearchX}
        title="No answers found"
        message={
          q
            ? `Nothing matches “${q}”. Try other words, or ask us in a chat.`
            : 'Nothing here yet. Ask us in a chat.'
        }
      />
    );
  } else {
    body = (
      <View style={{ gap: spacing[3] }}>
        <Text variant="caption" color="textMuted" accessibilityLiveRegion="polite">
          {results.data.data.length === 1 ? '1 answer' : `${results.data.data.length} answers`}
        </Text>
        {results.data.data.map(row)}
      </View>
    );
  }

  return (
    <Screen
      header={<SendHeader title="Help center" />}
      footer={
        <Button
          label="Still stuck? Chat with us"
          icon={MessageCircle}
          variant="secondary"
          onPress={() => router.push('/support/new')}
        />
      }
      edges={['top', 'bottom']}
    >
      <TextField
        label="Search help"
        value={text}
        onChangeText={setText}
        leadingIcon={Search}
        placeholder="e.g. transfer pending, freeze card"
        returnKeyType="search"
        autoCorrect={false}
        maxLength={100}
      />
      {categories.length > 0 && (
        <View style={[styles.wrap, { gap: spacing[2] }]}>
          <Chip label="All" selected={!category} onPress={() => setCategory(undefined)} />
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
