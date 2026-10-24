import type { Schema } from '@nem/contracts';
import * as Clipboard from 'expo-clipboard';
import { Copy, EyeOff } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Button, IconButton, Text, useToast } from '@/components';
import { haptic } from '@/lib/haptics';
import { useSecureScreen } from '@/lib/screenCapture';
import { useTheme } from '@/theme';

import { groupPan } from '../cards';

export type Props = {
  details: Schema<'CardSecrets'>;
  secondsLeft: number;
  onHide: () => void;
};

/**
 * Unlocked card details with a copy button each (CARD-3). Screen capture is
 * blocked while it is mounted, and it counts down to hiding itself.
 */
export function CardDetailsPanel({ details, secondsLeft, onHide }: Props) {
  const { colors, spacing, radius } = useTheme();
  const toast = useToast();
  useSecureScreen();

  const expiry = `${String(details.expiry_month).padStart(2, '0')}/${String(details.expiry_year).slice(-2)}`;
  const rows = [
    { label: 'Card number', value: groupPan(details.pan), copy: details.pan },
    { label: 'Expiry', value: expiry, copy: expiry },
    { label: 'CVV', value: details.cvv, copy: details.cvv },
  ];

  const copy = async (label: string, value: string) => {
    await Clipboard.setStringAsync(value);
    haptic('success');
    toast.show({ message: `${label} copied`, tone: 'success' });
  };

  return (
    <View style={{ gap: spacing[3] }}>
      <View
        style={{
          borderRadius: radius.lg,
          backgroundColor: colors.raised,
          paddingHorizontal: spacing[4],
        }}
      >
        {rows.map((row, i) => (
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
      <View style={[styles.row, { gap: spacing[2] }]}>
        <Text
          variant="bodySmall"
          color="textMuted"
          style={styles.flex}
          accessibilityLiveRegion="polite"
        >
          {`Hiding in ${secondsLeft} s. Only paste these into sites you trust.`}
        </Text>
        <Button label="Hide" icon={EyeOff} variant="ghost" size="sm" onPress={onHide} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
