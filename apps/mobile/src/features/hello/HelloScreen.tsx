import { useRouter } from 'expo-router';
import { LayoutGrid, LogIn, Zap } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Icon, Text } from '@/components';
import { useDemoSignIn } from '@/features/auth/hooks/useSessionActions';
import { devToolsEnabled, env } from '@/lib/env';
import { useTheme } from '@/theme';

export function HelloScreen() {
  const router = useRouter();
  const { colors, spacing } = useTheme();
  const demo = useDemoSignIn();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.content, { paddingHorizontal: spacing[6], gap: spacing[2] }]}>
        <View style={[styles.eyebrow, { gap: spacing[1] }]}>
          <Icon icon={Zap} size="sm" color="primaryText" />
          <Text variant="label" color="primaryText" style={styles.eyebrowText}>
            Hello
          </Text>
        </View>
        <Text variant="display">Nem Bank</Text>
        <Text color="textMuted" style={styles.subtitle}>
          Banking that moves at your speed. Simulated money, real engineering.
        </Text>
        <View style={{ gap: spacing[3], marginTop: spacing[6] }}>
          {/* The route gate opens Home once the session is stored. */}
          <Button
            label="Try the demo"
            loading={demo.isPending}
            onPress={() => demo.mutate({ body: { persona: 'tolu' } })}
          />
          <Button
            label="Log in"
            variant="secondary"
            icon={LogIn}
            onPress={() => router.push('/login')}
          />
          {demo.isError && (
            <Text variant="caption" color="danger" accessibilityRole="alert">
              {demo.error.message}. Try again.
            </Text>
          )}
        </View>
        {devToolsEnabled && (
          <Button
            label="Design system"
            variant="ghost"
            size="sm"
            icon={LayoutGrid}
            onPress={() => router.push('/kit')}
            style={{ marginTop: spacing[4] }}
          />
        )}
      </View>
      <Text
        variant="caption"
        color="textMuted"
        style={{ paddingHorizontal: spacing[6], paddingBottom: spacing[4] }}
      >
        Data: {env.apiMode === 'mock' ? 'mock bank (on device)' : env.apiUrl}
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, justifyContent: 'center' },
  eyebrow: { flexDirection: 'row', alignItems: 'center' },
  eyebrowText: { letterSpacing: 2, textTransform: 'uppercase' },
  subtitle: { maxWidth: 320 },
});
