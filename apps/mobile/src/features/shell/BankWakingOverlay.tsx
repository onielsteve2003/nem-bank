import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Button, Text } from '@/components';
import { useBankStore } from '@/stores';
import { useTheme } from '@/theme';

import { chooseDemoBank } from './useBankWarmup';

/** Offer the demo bank once the wait is no longer short. */
const OFFER_DEMO_AFTER_MS = 15_000;

/**
 * Cold-start screen (T31.4). The free host sleeps when idle, so the first request can
 * take up to a minute: say so, show that it is working, and give a way out (the
 * on-device demo bank) rather than a spinner with no end. It is an overlay, not a
 * route, so the app underneath keeps its place and refetches when the bank answers.
 */
export function BankWakingOverlay() {
  const status = useBankStore((s) => s.status);
  if (status !== 'waking' && status !== 'unreachable') return null;
  // Mounted only while blocked, so the "waited" timer starts fresh each time.
  return <WakingCover unreachable={status === 'unreachable'} />;
}

function WakingCover({ unreachable }: { unreachable: boolean }) {
  const { colors, spacing } = useTheme();
  const { t } = useTranslation();
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), OFFER_DEMO_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  const title = unreachable ? t('bank.unreachable.title') : t('bank.waking.title');
  const detail = unreachable ? t('bank.unreachable.detail') : t('bank.waking.detail');

  return (
    <View
      testID="bank-waking"
      style={[
        styles.cover,
        { backgroundColor: colors.background, padding: spacing[6], gap: spacing[4] },
      ]}
      accessibilityViewIsModal
    >
      {!unreachable && <ActivityIndicator size="large" color={colors.primary} />}
      <View
        accessible
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        accessibilityLabel={`${title}. ${detail}`}
        style={{ gap: spacing[2] }}
      >
        <Text variant="h2" style={styles.centre}>
          {title}
        </Text>
        <Text variant="body" color="textMuted" style={styles.centre}>
          {detail}
        </Text>
      </View>
      <View style={[styles.actions, { gap: spacing[3] }]}>
        {unreachable && (
          <Button
            label={t('bank.tryAgain')}
            fullWidth
            onPress={() => useBankStore.getState().retry()}
          />
        )}
        {(unreachable || waited) && (
          <Button
            label={t('bank.useDemo')}
            variant={unreachable ? 'secondary' : 'ghost'}
            accessibilityHint={t('bank.useDemoHint')}
            fullWidth
            onPress={chooseDemoBank}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  centre: { textAlign: 'center' },
  actions: { alignSelf: 'stretch' },
});
