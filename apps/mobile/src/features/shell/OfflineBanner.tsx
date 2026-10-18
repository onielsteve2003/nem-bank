import { CloudOff } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';

import { Icon, Text } from '@/components';
import { isOnline, useNetworkStore } from '@/stores';
import { useTheme } from '@/theme';

const timeFormat = new Intl.DateTimeFormat('en-NG', { hour: 'numeric', minute: '2-digit' });

/**
 * Says the app is offline, how old the data on screen is, and that money
 * actions need a connection: they are never queued to run later (ADR-10).
 */
export function OfflineBanner() {
  const { colors, spacing, radius } = useTheme();
  const online = useNetworkStore(isOnline);
  const simulated = useNetworkStore((s) => s.deviceOnline && s.simulatedOffline);
  const since = useNetworkStore((s) => s.lastOnlineAt);
  if (online) return null;

  const title = simulated ? 'Demo Controls has the bank offline' : 'You’re offline';
  const detail = `Showing what was saved at ${timeFormat.format(since)}. Payments need a connection.`;

  return (
    <Animated.View
      entering={FadeInUp.duration(200)}
      exiting={FadeOutUp.duration(150)}
      accessible
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${title}. ${detail}`}
      style={[
        styles.banner,
        {
          backgroundColor: colors.warning,
          borderRadius: radius.md,
          marginHorizontal: spacing[4],
          marginTop: spacing[1],
          paddingHorizontal: spacing[3],
          paddingVertical: spacing[2],
          gap: spacing[2],
        },
      ]}
    >
      <Icon icon={CloudOff} size="sm" color="onStatus" />
      <View style={styles.copy}>
        <Text variant="label" color="onStatus">
          {title}
        </Text>
        <Text variant="caption" color="onStatus">
          {detail}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center' },
  copy: { flex: 1 },
});
