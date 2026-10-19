import { ShieldAlert } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Icon, Text } from '@/components';
import { useSessionStore } from '@/stores';
import { useTheme } from '@/theme';

const untilFormat = new Intl.DateTimeFormat('en-NG', {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
});

/** "Tue 3:42 pm": when the cool-off ends, in the phone's own time zone. */
export function formatCoolOffEnd(iso: string): string {
  return untilFormat.format(new Date(iso));
}

/** Re-renders when `iso` passes, so the banner leaves on time without a reload. */
function useStillBefore(iso: string | null): boolean {
  const [now, setNow] = useState(Date.now);
  const left = iso ? Date.parse(iso) - now : 0;
  useEffect(() => {
    if (left <= 0) return;
    // Re-measures when it fires, so an end moved by a new session still lands on time.
    // setTimeout caps at ~24.8 days; a cool-off is 24 hours.
    const timer = setTimeout(() => setNow(Date.now()), left + 50);
    return () => clearTimeout(timer);
  }, [left]);
  return left > 0;
}

/**
 * Shown at the top of every signed-in screen while this device's new-device
 * cool-off runs (AUTH-8): outgoing limits are lower until it ends.
 */
export function CoolOffBanner() {
  const { colors, spacing, radius } = useTheme();
  const until = useSessionStore((s) => s.session?.coolOffUntil ?? null);
  const active = useStillBefore(until);
  if (!until || !active) return null;

  const title = 'New device: lower limits';
  const detail = `To keep your money safe, sending limits are lower on this device until ${formatCoolOffEnd(until)}.`;

  return (
    <View
      accessible
      accessibilityRole="summary"
      accessibilityLabel={`${title}. ${detail}`}
      style={[
        styles.banner,
        {
          backgroundColor: colors.info,
          borderRadius: radius.md,
          marginHorizontal: spacing[4],
          marginTop: spacing[1],
          paddingHorizontal: spacing[3],
          paddingVertical: spacing[2],
          gap: spacing[2],
        },
      ]}
    >
      <Icon icon={ShieldAlert} size="sm" color="onStatus" />
      <View style={styles.copy}>
        <Text variant="label" color="onStatus">
          {title}
        </Text>
        <Text variant="caption" color="onStatus">
          {detail}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center' },
  copy: { flex: 1 },
});
