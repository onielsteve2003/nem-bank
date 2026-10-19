import { useRouter } from 'expo-router';
import { Info, LayoutGrid, Zap } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Card, Icon, Text } from '@/components';
import { devToolsEnabled, env } from '@/lib/env';
import { useTheme } from '@/theme';

import { WelcomeCarousel } from '../components/WelcomeCarousel';
import { useDemoSignIn } from '../hooks/useSessionActions';
import { WELCOME_SLIDES } from '../welcomeSlides';

/** First screen for a signed-out visitor: what Nem Bank is, that it is a demo, and a one-tap way in (AUTH-11). */
export function WelcomeScreen() {
  const router = useRouter();
  const { colors, spacing } = useTheme();
  const demo = useDemoSignIn();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.brand,
          { paddingHorizontal: spacing[6], paddingTop: spacing[4], gap: spacing[2] },
        ]}
      >
        <Icon icon={Zap} size="md" color="primaryText" />
        <Text variant="h3" style={styles.flex}>
          Nem Bank
        </Text>
        {devToolsEnabled && (
          <Button
            label="Design system"
            variant="ghost"
            size="sm"
            icon={LayoutGrid}
            onPress={() => router.push('/kit')}
          />
        )}
      </View>

      <WelcomeCarousel slides={WELCOME_SLIDES} />

      <View style={{ paddingHorizontal: spacing[6], paddingTop: spacing[6], gap: spacing[3] }}>
        <Card variant="outline" accessibilityRole="text">
          <View style={[styles.disclaimer, { gap: spacing[3] }]}>
            <Icon icon={Info} size="md" color="info" />
            <Text variant="bodySmall" color="textMuted" style={styles.flex}>
              <Text variant="bodySmall">Not a real bank. </Text>
              Nem Bank is a portfolio demo: balances and transfers are simulated and no real money
              moves. Never enter real card or bank details.
            </Text>
          </View>
        </Card>

        {/* The route gate opens Home once the session is stored. */}
        <Button
          label="Try the demo"
          accessibilityHint="Signs you in as Tolu, a demo customer with six months of history"
          loading={demo.isPending}
          fullWidth
          onPress={() => demo.mutate({ body: { persona: 'tolu' } })}
        />
        {demo.isError && (
          <Text variant="caption" color="danger" accessibilityRole="alert">
            {demo.error.message}. Try again.
          </Text>
        )}
        <View style={[styles.row, { gap: spacing[3] }]}>
          <Button
            label="Create account"
            variant="secondary"
            style={styles.flex}
            onPress={() => router.push('/sign-up')}
          />
          <Button
            label="Log in"
            variant="ghost"
            style={styles.flex}
            onPress={() => router.push('/login')}
          />
        </View>
        <Text
          variant="caption"
          color="textMuted"
          style={[styles.center, { paddingBottom: spacing[2] }]}
        >
          Data: {env.apiMode === 'mock' ? 'mock bank (on device)' : env.apiUrl}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  brand: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  disclaimer: { flexDirection: 'row', alignItems: 'flex-start' },
  row: { flexDirection: 'row' },
  flex: { flex: 1 },
  center: { textAlign: 'center' },
});
