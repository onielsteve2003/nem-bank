import * as Clipboard from 'expo-clipboard';
import { Copy } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { IconButton, Text, useToast } from '@/components';
import { haptic } from '@/lib/haptics';
import { useTheme } from '@/theme';

import { detailRows, type ReceivingDetails } from './receivingDetails';

/** A wallet's receiving details, one row each with its own copy button (ACC-1, FX-3). */
export function ReceivingDetailsCard({ details }: { details: ReceivingDetails }) {
  const { colors, spacing, radius } = useTheme();
  const toast = useToast();

  const copy = async (label: string, value: string) => {
    await Clipboard.setStringAsync(value);
    haptic('success');
    toast.show({ message: `${label} copied`, tone: 'success' });
  };

  return (
    <View
      style={{
        borderRadius: radius.lg,
        backgroundColor: colors.raised,
        paddingHorizontal: spacing[4],
      }}
    >
      {detailRows(details).map((row, i) => (
        <View
          key={row.label}
          style={[
            styles.row,
            {
              paddingVertical: spacing[3],
              gap: spacing[2],
              borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
              borderColor: colors.border,
            },
          ]}
        >
          <View style={styles.flex} accessible accessibilityLabel={`${row.label}: ${row.value}`}>
            <Text variant="caption" color="textMuted">
              {row.label}
            </Text>
            <Text variant="bodyStrong" selectable>
              {row.value}
            </Text>
          </View>
          <IconButton
            icon={Copy}
            accessibilityLabel={`Copy ${row.label.toLowerCase()}`}
            variant="ghost"
            onPress={() => void copy(row.label, row.copy)}
          />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
