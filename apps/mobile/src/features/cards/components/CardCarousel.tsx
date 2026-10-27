import type { Schema } from '@nem/contracts';
import { useEffect, useRef, useState } from 'react';
import {
  FlatList,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { BankCard, PressableScale } from '@/components';
import { useTheme } from '@/theme';

import { bankCardProps } from '../cards';

type Card = Schema<'Card'>;

export type Props = {
  cards: Card[];
  index: number;
  onIndex: (index: number) => void;
  /** Unlocked details: that card turns to its back and shows them. */
  revealed?: { cardId: string; number: string; cvv: string };
};

/**
 * The cards one page at a time (CARD-2): swipe between them, or tap a dot. Only
 * the card in view tilts with the phone, so one motion sensor runs at a time.
 */
export function CardCarousel({ cards, index, onIndex, revealed }: Props) {
  const { colors, spacing, radius } = useTheme();
  const list = useRef<FlatList<Card>>(null);
  const window = useWindowDimensions();
  const [measured, setMeasured] = useState(0);
  // The window width until the first layout pass, so the first frame is not blank.
  const width = measured || window.width;

  const onLayout = (e: LayoutChangeEvent) => setMeasured(e.nativeEvent.layout.width);
  const onSettle = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(e.nativeEvent.contentOffset.x / width);
    if (next !== index && next >= 0 && next < cards.length) onIndex(next);
  };
  // Taps on a dot, a swipe that settled, or the parent picking a card (a link
  // to one card, a replaced card) all end here; a swipe is already in place.
  useEffect(() => {
    list.current?.scrollToOffset({ offset: index * width, animated: true });
  }, [index, width]);

  return (
    <View style={{ gap: spacing[3] }} onLayout={onLayout}>
      <FlatList
        ref={list}
        testID="card-carousel"
        data={cards}
        keyExtractor={(c) => c.id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={index}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        onMomentumScrollEnd={onSettle}
        renderItem={({ item, index: i }) => (
          <View style={{ width, paddingHorizontal: spacing[4] }}>
            <BankCard
              {...bankCardProps(item)}
              tilt={i === index}
              revealed={revealed?.cardId === item.id ? revealed : undefined}
              flipped={revealed?.cardId === item.id ? true : undefined}
            />
          </View>
        )}
      />
      {cards.length > 1 && (
        <View style={[styles.dots, { gap: spacing[1] }]}>
          {cards.map((c, i) => (
            <PressableScale
              key={c.id}
              accessibilityRole="button"
              accessibilityLabel={`Show card ${i + 1} of ${cards.length}`}
              accessibilityState={{ selected: i === index }}
              hitSlop={spacing[3]}
              onPress={() => onIndex(i)}
              style={styles.dotTarget}
            >
              <View
                style={{
                  width: i === index ? spacing[5] : spacing[2],
                  height: spacing[2],
                  borderRadius: radius.pill,
                  backgroundColor: i === index ? colors.primaryText : colors.border,
                }}
              />
            </PressableScale>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  dots: { flexDirection: 'row', justifyContent: 'center' },
  dotTarget: { minHeight: 24, justifyContent: 'center' },
});
