import { StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { env } from '@/lib/env';

// Temporary palette for the foundation milestone. T2.1 replaces it with the
// Volt Noir design tokens from @nem/shared.
const PALETTE = {
  dark: { background: '#0B0D12', text: '#F5F7FA', muted: '#9AA3B2', accent: '#D4FF3A' },
  light: { background: '#F7F7F2', text: '#0B0D12', muted: '#4A5160', accent: '#3F5200' },
} as const;

export function HelloScreen() {
  const colors = PALETTE[useColorScheme() === 'light' ? 'light' : 'dark'];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.content} accessibilityRole="header">
        <Text style={[styles.eyebrow, { color: colors.accent }]}>Hello</Text>
        <Text style={[styles.title, { color: colors.text }]}>Nem Bank</Text>
        <Text style={[styles.subtitle, { color: colors.muted }]}>
          Banking that moves at your speed. Simulated money, real engineering.
        </Text>
      </View>
      <Text style={[styles.footer, { color: colors.muted }]}>
        Data: {env.apiMode === 'mock' ? 'mock bank (on device)' : env.apiUrl}
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, justifyContent: 'center', paddingHorizontal: 24, gap: 8 },
  eyebrow: { fontSize: 14, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase' },
  title: { fontSize: 44, fontWeight: '800', letterSpacing: -1 },
  subtitle: { fontSize: 16, lineHeight: 24, maxWidth: 320 },
  footer: { fontSize: 12, paddingHorizontal: 24, paddingBottom: 16 },
});
