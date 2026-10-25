import type { Tabs } from 'expo-router';
import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Badge, Text } from '@/components';
import { haptic } from '@/lib/haptics';
import { useTheme } from '@/theme';

export type Props = Parameters<NonNullable<ComponentProps<typeof Tabs>['tabBar']>>[0];

const ICON_SIZE = 22;
const PILL_WIDTH = 56;
const PILL_HEIGHT = 32;
/** The active icon grows from this on selection, so the change reads at a glance. */
const ICON_REST_SCALE = 0.86;

/**
 * The Volt Noir tab bar (T4.3): a volt pill slides under the active icon, the
 * selection taps a light haptic, and each tab is a real `tab` for screen readers.
 * With reduce motion on, the pill jumps and the icon does not grow.
 */
export function TabBar({ state, descriptors, emitter, navigateToTab }: Props) {
  const { colors, spacing, motion } = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const [tabWidth, setTabWidth] = useState(0);
  const pillX = useSharedValue(0);

  useEffect(() => {
    if (tabWidth === 0) return;
    const x = state.index * tabWidth + (tabWidth - PILL_WIDTH) / 2;
    pillX.set(reduceMotion ? x : withSpring(x, motion.spring.snappy));
  }, [state.index, tabWidth, reduceMotion, motion, pillX]);

  const pillStyle = useAnimatedStyle(() => ({ transform: [{ translateX: pillX.value }] }));

  const onLayout = (e: LayoutChangeEvent) =>
    setTabWidth(e.nativeEvent.layout.width / state.routes.length);

  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.bar,
        {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          paddingTop: spacing[2],
          paddingBottom: Math.max(insets.bottom, spacing[2]),
        },
      ]}
    >
      <View style={styles.row} onLayout={onLayout}>
        {tabWidth > 0 && (
          <Animated.View
            pointerEvents="none"
            style={[styles.pill, { backgroundColor: colors.primary }, pillStyle]}
          />
        )}
        {state.routes.map((route, index) => {
          const descriptor = descriptors[route.key];
          if (!descriptor) return null;
          const { options } = descriptor;
          const focused = state.index === index;
          const title = typeof options.title === 'string' ? options.title : route.name;

          const onPress = () => {
            const event = emitter.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!focused && !event.defaultPrevented) {
              haptic('selection');
              navigateToTab(route.key);
            }
          };

          return (
            <TabButton
              key={route.key}
              title={title}
              focused={focused}
              position={`${index + 1} of ${state.routes.length}`}
              badge={options.tabBarBadge}
              icon={options.tabBarIcon?.({
                focused,
                color: focused ? colors.onPrimary : colors.textMuted,
                size: ICON_SIZE,
              })}
              onPress={onPress}
              onLongPress={() => emitter.emit({ type: 'tabLongPress', target: route.key })}
            />
          );
        })}
      </View>
    </View>
  );
}

type TabButtonProps = {
  title: string;
  focused: boolean;
  position: string;
  badge: string | number | undefined;
  icon: ReactNode;
  onPress: () => void;
  onLongPress: () => void;
};

function TabButton({
  title,
  focused,
  position,
  badge,
  icon,
  onPress,
  onLongPress,
}: TabButtonProps) {
  const { spacing, motion } = useTheme();
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(focused ? 1 : ICON_REST_SCALE);

  useEffect(() => {
    const target = focused ? 1 : ICON_REST_SCALE;
    scale.set(reduceMotion ? target : withSpring(target, motion.spring.bouncy));
  }, [focused, reduceMotion, motion, scale]);

  const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={title}
      accessibilityHint={position}
      accessibilityState={{ selected: focused }}
      onPress={onPress}
      onLongPress={onLongPress}
      style={[styles.tab, { gap: spacing[1] }]}
    >
      <Animated.View style={[styles.icon, iconStyle]}>
        {icon}
        {badge !== undefined && (
          <View style={styles.badge}>
            {typeof badge === 'number' ? (
              <Badge count={badge} tone="danger" />
            ) : (
              <Badge label={badge} tone="danger" />
            )}
          </View>
        )}
      </Animated.View>
      <Text variant="caption" color={focused ? 'text' : 'textMuted'} numberOfLines={1}>
        {title}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row' },
  pill: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: PILL_WIDTH,
    height: PILL_HEIGHT,
    borderRadius: PILL_HEIGHT / 2,
  },
  tab: { flex: 1, alignItems: 'center', minHeight: 44 },
  icon: { height: PILL_HEIGHT, justifyContent: 'center' },
  badge: { position: 'absolute', top: -2, left: ICON_SIZE - 4 },
});
