import type { Schema } from '@nem/contracts';
import { DURATION } from '@nem/shared';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { Icon, MoneyText, Text } from '@/components';
import { CATEGORIES } from '@/features/transactions/categories';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { SLIDE_LOOK, slideIcon } from '../story';

export type Props = {
  slide: Schema<'StorySlide'>;
  hidden: boolean;
};

/** One Money Story slide: a big accent icon, the headline, the amount counting up, the line under it. */
export function StorySlideView({ slide, hidden }: Props) {
  const { colors, radius, spacing } = useTheme();
  const look = SLIDE_LOOK[slide.kind];
  const accent = colors[look.accent];
  const category = slide.category ? (CATEGORIES[slide.category] ?? CATEGORIES.other) : null;

  return (
    // Keyed by the parent, so every slide enters afresh; Reanimated skips it under reduce motion.
    <Animated.View
      entering={FadeInDown.duration(DURATION.slow)}
      style={[styles.slide, { gap: spacing[5] }]}
    >
      <View
        style={[
          styles.badge,
          { borderRadius: radius.pill, backgroundColor: accent, marginBottom: spacing[2] },
        ]}
      >
        <Icon
          icon={slideIcon(slide)}
          size="xl"
          color={look.accent === 'primary' ? 'onPrimary' : 'onStatus'}
        />
      </View>
      <Text variant="h1" accessibilityRole="header">
        {slide.title}
      </Text>
      {category && (
        <Text variant="h3" color="textMuted">
          {category.label}
        </Text>
      )}
      {slide.amount && (
        <MoneyText value={fromApiMoney(slide.amount)} variant="display" animate masked={hidden} />
      )}
      <Text variant="body" color="textMuted">
        {slide.body}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  slide: { flex: 1, justifyContent: 'center' },
  badge: { width: 72, height: 72, alignItems: 'center', justifyContent: 'center' },
});
