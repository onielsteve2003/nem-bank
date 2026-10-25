import { formatMoney } from '@nem/shared';
import { Share2, X } from 'lucide-react-native';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AmountInput,
  BottomSheet,
  Button,
  ErrorState,
  Skeleton,
  Text,
  useToast,
} from '@/components';
import { QrCode } from '@/features/statements/QrCode';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { canShareImage, shareViewAsImage } from '@/lib/share';
import { useTheme } from '@/theme';

import { typedNaira } from '../amount';
import { countdown } from '../qr';

/**
 * "My QR" (TRF-13): a code the bank signs, for anyone on Nem to scan and pay
 * the customer's naira account. With an amount it lasts 15 minutes, then a
 * fresh one is fetched, so an old screenshot can't be reused for a new sale.
 */
export function MyQr() {
  const { colors, spacing, radius } = useTheme();
  const toast = useToast();
  const card = useRef<ComponentRef<typeof View>>(null);
  const [typed, setTyped] = useState('');
  const [asked, setAsked] = useState<bigint | null>(null);
  const [editing, setEditing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const accounts = useRepoQuery('accounts', 'list');
  const ngn = accounts.data?.data.find((a) => a.currency === 'NGN');
  const details = ngn?.receiving_details.scheme === 'nuban' ? ngn.receiving_details : null;
  const qr = useRepoQuery(
    'paymentLinks',
    'getMyQr',
    {
      query: {
        account_id: ngn?.id ?? '',
        ...(asked ? { amount_minor: asked.toString() } : {}),
      },
    },
    { enabled: Boolean(ngn) },
  );
  const expiresAt = qr.data?.expires_at ?? null;
  const { refetch } = qr;

  // Ticks the countdown, and swaps in a fresh code the moment this one lapses.
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= Date.parse(expiresAt)) void refetch();
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAt, refetch]);

  const share = async () => {
    try {
      await shareViewAsImage(card, 'My Nem QR');
    } catch {
      toast.show({ message: "We couldn't share the code. Try again.", tone: 'error' });
    }
  };

  const amount = qr.data?.amount ? fromApiMoney(qr.data.amount) : null;
  const typedAmount = typedNaira(typed);

  if (accounts.isError || qr.isError) {
    return (
      <ErrorState
        title="We couldn't make your code"
        onRetry={() => void (accounts.isError ? accounts.refetch() : qr.refetch())}
      />
    );
  }

  return (
    <View style={{ gap: spacing[4] }}>
      <View
        ref={card}
        collapsable={false}
        style={[
          styles.card,
          {
            gap: spacing[3],
            padding: spacing[5],
            borderRadius: radius.xl,
            backgroundColor: colors.surface,
          },
        ]}
      >
        <View style={{ padding: spacing[3], borderRadius: radius.lg, backgroundColor: '#FFFFFF' }}>
          {qr.data ? (
            <QrCode
              value={qr.data.payload}
              size={220}
              accessibilityLabel={
                amount
                  ? `Your QR code asking for ${formatMoney(amount)}`
                  : 'Your QR code to receive money'
              }
            />
          ) : (
            <Skeleton width={220} height={220} />
          )}
        </View>
        {details && (
          <View style={styles.center}>
            <Text variant="bodyStrong" align="center">
              {details.account_name}
            </Text>
            <Text variant="bodySmall" color="textMuted" align="center">
              {details.bank_name} · {details.account_number}
            </Text>
          </View>
        )}
        {amount && (
          <View style={styles.center}>
            <Text variant="h2" align="center">
              {formatMoney(amount)}
            </Text>
            {expiresAt && (
              <Text
                variant="bodySmall"
                color="textMuted"
                align="center"
                accessibilityLabel="Code refreshes every 15 minutes"
              >
                New code in {countdown(expiresAt, now)}
              </Text>
            )}
          </View>
        )}
      </View>

      <View style={[styles.row, { gap: spacing[2] }]}>
        <View style={styles.flex}>
          {amount ? (
            <Button
              label="Remove amount"
              icon={X}
              variant="secondary"
              onPress={() => {
                setAsked(null);
                setTyped('');
              }}
            />
          ) : (
            <Button
              label="Ask for an amount"
              variant="secondary"
              onPress={() => setEditing(true)}
            />
          )}
        </View>
        {canShareImage && (
          <View style={styles.flex}>
            <Button label="Share" icon={Share2} disabled={!qr.data} onPress={share} />
          </View>
        )}
      </View>

      <BottomSheet open={editing} onClose={() => setEditing(false)} title="Ask for an amount">
        <View style={{ gap: spacing[4] }}>
          <AmountInput currency="NGN" value={typed} onChangeValue={setTyped} />
          <Button
            label={typedAmount ? `Show code for ${formatMoney(typedAmount)}` : 'Show code'}
            disabled={!typedAmount}
            onPress={() => {
              if (!typedAmount) return;
              setAsked(typedAmount.amount);
              setEditing(false);
            }}
          />
        </View>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { alignItems: 'center' },
  center: { alignItems: 'center', gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
