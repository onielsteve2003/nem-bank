import type { Schema } from '@nem/contracts';
import { useRouter } from 'expo-router';
import { CreditCard, Plus } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  IconButton,
  ListItem,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
} from '@/components';
import { isApiError } from '@/data';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { cardFacts, cardName, closedReason, isOpen } from '../cards';
import { CardCarousel } from '../components/CardCarousel';

/** The most cards one person can hold open at once (the bank enforces it too). */
export const MAX_OPEN_CARDS = 5;

/**
 * Cards home (CARD-1, CARD-2): open cards in a 3D carousel with what each one
 * is for, a way to make another, and the cards that have closed.
 */
export function CardsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const cards = useRepoQuery('cards', 'list');
  const [index, setIndex] = useState(0);

  const all = cards.data?.data ?? [];
  const open = all.filter(isOpen);
  const closed = all.filter((c) => !isOpen(c));
  const atMax = open.length >= MAX_OPEN_CARDS;
  const current: Schema<'Card'> | undefined = open[Math.min(index, open.length - 1)];
  const create = () => router.push('/new-card');

  const header = (
    <View style={[styles.row, { paddingHorizontal: spacing[4], gap: spacing[2] }]}>
      <Text variant="title" accessibilityRole="header" style={styles.flex}>
        Cards
      </Text>
      {open.length > 0 && !atMax && (
        <IconButton icon={Plus} accessibilityLabel="New card" variant="ghost" onPress={create} />
      )}
    </View>
  );

  return (
    <Screen
      header={header}
      padded={false}
      edges={['top']}
      onRefresh={() => void cards.refetch()}
      refreshing={cards.isRefetching}
      contentContainerStyle={{ gap: spacing[5], paddingVertical: spacing[4] }}
    >
      {cards.isError ? (
        <ErrorState
          kind={
            isApiError(cards.error) && cards.error.problem.code === 'offline' ? 'offline' : 'error'
          }
          title="We couldn't load your cards"
          onRetry={() => cards.refetch()}
        />
      ) : !cards.data ? (
        <View style={{ paddingHorizontal: spacing[4] }}>
          <SkeletonGroup accessibilityLabel="Loading cards">
            <Skeleton height={210} radius={16} />
            <Skeleton height={20} width="60%" />
          </SkeletonGroup>
        </View>
      ) : open.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title="No cards yet"
          message="Make a virtual card in seconds for online shopping, subscriptions or a single payment."
          actionLabel="Create a virtual card"
          onAction={create}
        />
      ) : (
        <>
          <CardCarousel cards={open} index={Math.min(index, open.length - 1)} onIndex={setIndex} />
          {current && (
            <View style={{ paddingHorizontal: spacing[4], gap: spacing[1] }}>
              <View style={[styles.row, { gap: spacing[2] }]}>
                <Text variant="h3" style={styles.flex} numberOfLines={1}>
                  {cardName(current)}
                </Text>
                {current.status === 'frozen' && <Badge label="Frozen" tone="info" />}
              </View>
              {cardFacts(current).map((fact) => (
                <Text key={fact} color="textMuted">
                  {fact}
                </Text>
              ))}
              <Text variant="caption" color="textMuted">
                Tap the card to see its back.
              </Text>
            </View>
          )}
          <View style={{ paddingHorizontal: spacing[4] }}>
            {atMax ? (
              <Text variant="bodySmall" color="textMuted">
                You have {MAX_OPEN_CARDS} cards, the most you can hold. Terminate one to make
                another.
              </Text>
            ) : (
              <Button
                label="Create a virtual card"
                icon={Plus}
                variant="secondary"
                fullWidth
                onPress={create}
              />
            )}
          </View>
        </>
      )}

      {closed.length > 0 && (
        <View style={{ paddingHorizontal: spacing[2] }}>
          <View style={{ paddingHorizontal: spacing[2] }}>
            <SectionHeader title="Closed cards" />
          </View>
          {closed.map((c) => (
            <ListItem
              key={c.id}
              title={cardName(c)}
              subtitle={`${c.currency} · ends ${c.last4}`}
              trailing={<Badge label={closedReason(c)} />}
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  flex: { flex: 1 },
});
