import { useRouter } from 'expo-router';
import { Bell } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Badge, IconButton, badgeCountLabel } from '@/components';
import { useRepoQuery } from '@/lib/query';

/** The inbox button with its unread count, kept current by realtime events (NOT-1). */
export function NotificationBell() {
  const router = useRouter();
  const q = useRepoQuery('notifications', 'list', { query: { limit: 1 } });
  const unread = q.data?.unread_count ?? 0;
  return (
    <View>
      <IconButton
        icon={Bell}
        variant="ghost"
        accessibilityLabel={
          unread ? `Notifications, ${badgeCountLabel(unread)} unread` : 'Notifications'
        }
        onPress={() => router.push('/notifications')}
      />
      {unread > 0 && (
        // The button already says the count.
        <View
          style={styles.badge}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Badge count={unread} tone="primary" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { position: 'absolute', top: 2, right: 0 },
});
