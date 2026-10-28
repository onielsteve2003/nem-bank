import { Check, X } from 'lucide-react-native';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Icon, Text } from '@/components';
import { useTheme } from '@/theme';

import type { NemtagStatus } from '../useNemtagCheck';

/** One line under a @nemtag field: checking, available, taken or why not. */
export function NemtagStatusLine({
  status,
  checking,
}: {
  status: NemtagStatus;
  checking: boolean;
}) {
  const { spacing } = useTheme();
  return (
    <View
      style={[styles.row, { gap: spacing[1] }]}
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={status.text}
    >
      {checking ? (
        <ActivityIndicator size="small" />
      ) : (
        status.tone !== 'textMuted' && (
          <Icon icon={status.tone === 'success' ? Check : X} size="sm" color={status.tone} />
        )
      )}
      <Text variant="bodySmall" color={status.tone}>
        {status.text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center' } });
