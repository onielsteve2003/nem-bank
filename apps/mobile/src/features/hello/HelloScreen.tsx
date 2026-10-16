import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { env } from '@/lib/env';
import { useTheme } from '@/theme';

export function HelloScreen() {
  const { colors, type, spacing } = useTheme();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View
        style={[styles.content, { paddingHorizontal: spacing[6], gap: spacing[2] }]}
        accessibilityRole="header"
      >
        <Text style={[type.label, styles.eyebrow, { color: colors.primaryText }]}>Hello</Text>
        <Text style={[type.display, { color: colors.text }]}>Nem Bank</Text>
        <Text style={[type.body, styles.subtitle, { color: colors.textMuted }]}>
          Banking that moves at your speed. Simulated money, real engineering.
        </Text>
      </View>
      <Text
        style={[
          type.caption,
          { color: colors.textMuted, paddingHorizontal: spacing[6], paddingBottom: spacing[4] },
        ]}
      >
        Data: {env.apiMode === 'mock' ? 'mock bank (on device)' : env.apiUrl}
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, justifyContent: 'center' },
  eyebrow: { letterSpacing: 2, textTransform: 'uppercase' },
  subtitle: { maxWidth: 320 },
});
