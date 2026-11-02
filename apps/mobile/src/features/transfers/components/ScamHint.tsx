import type { ScamReason } from '@nem/shared';
import { useRouter } from 'expo-router';
import { ShieldAlert } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Button, Icon, Text } from '@/components';
import { useTheme } from '@/theme';
import { useTranslation } from 'react-i18next';

type Props = { reason: ScamReason };

/**
 * A heads-up from the on-device scam rules (AI-2) while a payment is typed.
 * It never blocks: the customer decides, with a way to check more closely.
 */
export function ScamHint({ reason }: Props) {
  const router = useRouter();
  const { colors, radius, spacing } = useTheme();
  const { t } = useTranslation();
  const color = reason.severity === 'high' ? 'danger' : 'warning';

  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[
        styles.box,
        {
          borderColor: colors[color],
          borderRadius: radius.md,
          padding: spacing[3],
          gap: spacing[2],
        },
      ]}
    >
      <View style={[styles.row, { gap: spacing[2] }]}>
        <Icon icon={ShieldAlert} color={color} size="sm" />
        <Text variant="bodyStrong" style={styles.flex}>
          {reason.severity === 'high' ? t('transfers.scam.high') : t('transfers.scam.medium')}
        </Text>
      </View>
      <Text variant="bodySmall">{reason.message}</Text>
      <Button
        label={t('transfers.scam.check')}
        variant="ghost"
        size="sm"
        style={styles.start}
        onPress={() => router.push('/security/scam')}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  start: { alignSelf: 'flex-start' },
});
