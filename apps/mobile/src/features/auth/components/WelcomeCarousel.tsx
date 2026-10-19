import { useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import { Icon, Text } from '@/components';
import { useTheme } from '@/theme';

import type { WelcomeSlide } from '../welcomeSlides';

const ART_SIZE = 96;
const DOT = 8;
const DOT_ACTIVE = 24;

/**
 * Swipeable slides with page dots. Width comes from layout, not the window, so
 * it pages correctly inside the web demo's phone frame. Screen readers get one
 * adjustable element: swipe up or down to move between slides.
 */
export function WelcomeCarousel({ slides }: { slides: readonly WelcomeSlide[] }) {
  const { colors, spacing, radius } = useTheme();
  const scroller = useRef<ScrollView>(null);
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);

  const goTo = (next: number) => {
    const clamped = Math.max(0, Math.min(slides.length - 1, next));
    setIndex(clamped);
    scroller.current?.scrollTo({ x: clamped * width, animated: true });
  };

  // onScroll rather than onMomentumScrollEnd: browsers never send momentum events.
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (width === 0) return;
    const next = Math.round(event.nativeEvent.contentOffset.x / width);
    if (next !== index && next >= 0 && next < slides.length) setIndex(next);
  };

  const onAccessibilityAction = ({ nativeEvent }: AccessibilityActionEvent) => {
    if (nativeEvent.actionName === 'increment') goTo(index + 1);
    if (nativeEvent.actionName === 'decrement') goTo(index - 1);
  };

  const current = slides[index];

  return (
    <View style={styles.root}>
      <View
        style={styles.root}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={current ? `${current.title}. ${current.body}` : undefined}
        accessibilityValue={{ text: `Slide ${index + 1} of ${slides.length}` }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={onAccessibilityAction}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        <ScrollView
          ref={scroller}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onScroll={onScroll}
          scrollEventThrottle={32}
        >
          {slides.map((slide) => (
            <View
              key={slide.key}
              style={[styles.slide, { width, paddingHorizontal: spacing[6], gap: spacing[4] }]}
            >
              <View
                style={[
                  styles.art,
                  {
                    backgroundColor: colors.raised,
                    borderRadius: radius.xl,
                    marginBottom: spacing[4],
                  },
                ]}
              >
                <Icon icon={slide.icon} size="xl" color="primaryText" />
              </View>
              <Text variant="h1">{slide.title}</Text>
              <Text color="textMuted" style={styles.body}>
                {slide.body}
              </Text>
            </View>
          ))}
        </ScrollView>
      </View>

      <View style={[styles.dots, { gap: spacing[2], paddingHorizontal: spacing[6] }]}>
        {slides.map((slide, i) => (
          <Pressable
            key={slide.key}
            accessibilityRole="button"
            accessibilityLabel={`Slide ${i + 1} of ${slides.length}`}
            accessibilityState={{ selected: i === index }}
            hitSlop={{ top: 18, bottom: 18, left: 4, right: 4 }}
            onPress={() => goTo(i)}
          >
            <View
              style={{
                width: i === index ? DOT_ACTIVE : DOT,
                height: DOT,
                borderRadius: DOT / 2,
                backgroundColor: i === index ? colors.primary : colors.border,
              }}
            />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  slide: { justifyContent: 'center' },
  art: { width: ART_SIZE, height: ART_SIZE, alignItems: 'center', justifyContent: 'center' },
  body: { maxWidth: 340 },
  dots: { flexDirection: 'row', alignItems: 'center' },
});
