import { FileText, Image as ImageIcon } from 'lucide-react-native';
import { useRef, useState, type ComponentRef } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  BottomSheet,
  Button,
  ErrorState,
  MoneyText,
  Skeleton,
  SkeletonGroup,
  StatusPill,
  Text,
  useToast,
} from '@/components';
import { haptic } from '@/lib/haptics';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { canShareImage, shareHtmlAsPdf, shareViewAsImage } from '@/lib/share';
import { useTheme } from '@/theme';

import { receiptFileTitle, receiptHtml, receiptLines } from './receipt';

export type Props = { transactionId: string; onClose: () => void };

/**
 * The receipt for one transaction (ACC-7). The card the customer sees is the
 * exact view captured for "Share as image"; the PDF is the same lines laid out
 * for paper. The amount is shown even in privacy mode: opening a receipt to
 * share it is a deliberate act.
 */
export function ReceiptSheet({ transactionId, onClose }: Props) {
  const { colors, spacing, radius } = useTheme();
  const toast = useToast();
  const card = useRef<ComponentRef<typeof View>>(null);
  const [busy, setBusy] = useState<'image' | 'pdf' | null>(null);
  const query = useRepoQuery('transactions', 'getReceipt', {
    path: { transaction_id: transactionId },
  });
  // The operation can also answer with the PDF itself (Accept: application/pdf);
  // the app always asks for JSON and lays the PDF out on the device.
  const r = typeof query.data === 'object' ? query.data : undefined;

  const share = async (kind: 'image' | 'pdf') => {
    if (!r) return;
    setBusy(kind);
    try {
      if (kind === 'image') await shareViewAsImage(card, receiptFileTitle(r));
      else await shareHtmlAsPdf(receiptHtml(r), receiptFileTitle(r));
      haptic('success');
    } catch {
      toast.show({ message: "We couldn't share the receipt. Try again.", tone: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <BottomSheet open onClose={onClose} title="Receipt" snapPoints={['90%']}>
      {!r ? (
        query.isError ? (
          <ErrorState title="We couldn't load the receipt" onRetry={() => void query.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel="Loading receipt">
            <Skeleton height={420} radius={24} />
          </SkeletonGroup>
        )
      ) : (
        <View style={{ gap: spacing[4] }}>
          <View
            ref={card}
            // Android drops views it thinks are layout-only; capture needs a real one.
            collapsable={false}
            style={{
              backgroundColor: colors.raised,
              borderRadius: radius.lg,
              padding: spacing[5],
              gap: spacing[3],
            }}
          >
            <View style={[styles.row, { gap: spacing[2] }]}>
              <View
                style={{
                  backgroundColor: colors.primary,
                  borderRadius: radius.sm,
                  paddingHorizontal: spacing[2],
                }}
              >
                <Text variant="bodyStrong" color="onPrimary">
                  Nem
                </Text>
              </View>
              <Text variant="bodyStrong">Bank receipt</Text>
            </View>
            <MoneyText value={fromApiMoney(r.amount)} variant="amountLarge" />
            <StatusPill status={r.status} />
            <View accessibilityRole="list">
              {receiptLines(r).map((line) => (
                <View
                  key={line.label}
                  style={[
                    styles.row,
                    styles.line,
                    { borderColor: colors.border, paddingVertical: spacing[2], gap: spacing[3] },
                  ]}
                  accessible
                  accessibilityLabel={`${line.label}: ${line.value.replace('\n', ', ')}`}
                >
                  <Text variant="caption" color="textMuted" style={styles.label}>
                    {line.label}
                  </Text>
                  <Text variant="caption" style={styles.value} selectable>
                    {line.value}
                  </Text>
                </View>
              ))}
            </View>
            <Text variant="caption" color="textMuted">
              Demo bank. Simulated money, not a real bank document.
            </Text>
          </View>

          {canShareImage && (
            <Button
              label="Share as image"
              icon={ImageIcon}
              loading={busy === 'image'}
              disabled={busy !== null}
              onPress={() => void share('image')}
            />
          )}
          <Button
            label={canShareImage ? 'Share as PDF' : 'Save as PDF'}
            icon={FileText}
            variant={canShareImage ? 'secondary' : 'primary'}
            loading={busy === 'pdf'}
            disabled={busy !== null}
            onPress={() => void share('pdf')}
          />
          {!canShareImage && (
            <Text variant="caption" color="textMuted" style={styles.center}>
              {
                'Your browser opens its print window. Choose "Save as PDF". Image sharing is in the app.'
              }
            </Text>
          )}
        </View>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  line: { alignItems: 'flex-start', borderBottomWidth: StyleSheet.hairlineWidth },
  label: { width: 112 },
  value: { flex: 1, textAlign: 'right' },
  center: { textAlign: 'center' },
});
