import { useRouter } from 'expo-router';
import { ArrowLeft, X } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { IconButton, Text } from '@/components';
import { useTheme } from '@/theme';

/**
 * The send flow's header: a close button on the first screen (it is a modal),
 * a back button on the steps after it.
 */
export function SendHeader({ title, first = false }: { title: string; first?: boolean }) {
  const router = useRouter();
  const { spacing } = useTheme();
  return (
    <View style={[styles.row, { paddingHorizontal: spacing[4], gap: spacing[2] }]}>
      {!first && (
        <IconButton
          icon={ArrowLeft}
          accessibilityLabel="Back"
          variant="ghost"
          onPress={() => router.back()}
        />
      )}
      <Text variant="title" accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {first && (
        <IconButton
          icon={X}
          accessibilityLabel="Close"
          variant="ghost"
          onPress={() => router.back()}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  title: { flex: 1 },
});
