import type { Schema } from '@nem/contracts';
import * as Clipboard from 'expo-clipboard';
import { Copy, Pause, Play, Share2 } from 'lucide-react-native';
import { useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';

import { Badge, BottomSheet, Button, Text, useToast } from '@/components';
import { QrCode } from '@/features/statements/QrCode';
import { haptic } from '@/lib/haptics';
import { useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { LINK_STATUS, linkAmountLabel, linkErrorMessage, linkShareMessage } from '../paymentLinks';

type PaymentLink = Schema<'PaymentLink'>;

/**
 * One of the customer's payment links (TRF-12): a QR anyone can scan, the link
 * to copy or share, and a switch to pause it without losing its history.
 */
export function LinkSheet({ link, onClose }: { link: PaymentLink; onClose: () => void }) {
  const { colors, spacing, radius } = useTheme();
  const toast = useToast();
  const update = useRepoMutation('paymentLinks', 'update', { invalidates: [['paymentLinks']] });
  const [status, setStatus] = useState(link.status);
  const meta = LINK_STATUS[status];

  const copy = async () => {
    await Clipboard.setStringAsync(link.url);
    haptic('success');
    toast.show({ message: 'Link copied', tone: 'success' });
  };

  const share = async () => {
    try {
      await Share.share({ message: linkShareMessage(link), url: link.url });
    } catch {
      toast.show({
        message: "Sharing isn't available here. Copy the link instead.",
        tone: 'error',
      });
    }
  };

  const toggle = () => {
    const next = status === 'active' ? 'inactive' : 'active';
    update.mutate(
      { path: { link_id: link.id }, body: { status: next } },
      {
        onSuccess: (saved) => {
          setStatus(saved.status);
          toast.show({
            message: saved.status === 'active' ? 'Link is taking payments' : 'Link paused',
            tone: 'success',
          });
        },
        onError: (e) => toast.show({ message: linkErrorMessage(e), tone: 'error' }),
      },
    );
  };

  return (
    <BottomSheet open onClose={onClose} title={link.title}>
      <View style={{ gap: spacing[4] }}>
        <View style={[styles.row, { gap: spacing[2] }]}>
          <Text variant="bodyStrong" style={styles.flex}>
            {linkAmountLabel(link)}
          </Text>
          <Badge label={meta.label} tone={meta.tone} />
        </View>
        {link.note ? <Text color="textMuted">{link.note}</Text> : null}

        {status === 'active' && (
          <View style={styles.center}>
            <View
              style={{ padding: spacing[3], borderRadius: radius.lg, backgroundColor: '#FFFFFF' }}
            >
              <QrCode
                value={link.url}
                size={176}
                accessibilityLabel={`QR code for the ${link.title} pay link`}
              />
            </View>
          </View>
        )}

        <View
          style={{
            borderRadius: radius.md,
            backgroundColor: colors.raised,
            padding: spacing[3],
          }}
        >
          <Text variant="bodySmall" selectable numberOfLines={2}>
            {link.url}
          </Text>
        </View>

        <View style={[styles.row, { gap: spacing[2] }]}>
          <View style={styles.flex}>
            <Button label="Copy" icon={Copy} variant="secondary" onPress={copy} />
          </View>
          <View style={styles.flex}>
            <Button label="Share" icon={Share2} disabled={status !== 'active'} onPress={share} />
          </View>
        </View>
        {status !== 'expired' && (
          <Button
            label={status === 'active' ? 'Pause link' : 'Take payments again'}
            icon={status === 'active' ? Pause : Play}
            variant="ghost"
            loading={update.isPending}
            onPress={toggle}
          />
        )}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center' },
  flex: { flex: 1 },
});
