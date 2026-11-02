import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { Ban, Send, XCircle } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Avatar, Badge, BottomSheet, Button, Card, Dialog, Text } from '@/components';
import { formatDateTime } from '@/features/transactions/format';
import { fromApiMoney } from '@/lib/money';
import { useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { counterpartOf, expiresIn, REQUEST_STATUS, requestErrorMessage } from '../requests';
import { useTranslation } from 'react-i18next';

type MoneyRequest = Schema<'MoneyRequest'>;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.between}>
      <Text color="textMuted">{label}</Text>
      <Text variant="bodyStrong" style={styles.value}>
        {value}
      </Text>
    </View>
  );
}

interface Props {
  request: MoneyRequest;
  onClose: () => void;
  /** Incoming and open: the screen takes over to confirm with the PIN. */
  onPay: (r: MoneyRequest) => void;
}

/**
 * One money request (TRF-10). Someone asking the customer: pay or decline.
 * One the customer sent: see where it stands, or cancel it while it is open.
 * Mount it only while a request is chosen.
 */
export function RequestSheet({ request, onClose, onPay }: Props) {
  const { spacing } = useTheme();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const { t } = useTranslation();
  const incoming = request.direction === 'incoming';
  const decline = useRepoMutation('moneyRequests', 'decline');
  const cancel = useRepoMutation('moneyRequests', 'cancel');
  const close = incoming ? decline : cancel;
  const other = counterpartOf(request);
  const firstName = other.name.split(' ')[0];
  const amount = formatMoney(fromApiMoney(request.amount));
  const status = REQUEST_STATUS[request.status];
  const open = request.status === 'pending';

  const closeIt = () =>
    close.mutate(
      { path: { request_id: request.id } },
      {
        onSuccess: () => {
          setConfirm(false);
          onClose();
        },
        onError: (e) => {
          setConfirm(false);
          setError(requestErrorMessage(e));
        },
      },
    );

  return (
    <BottomSheet
      open
      onClose={onClose}
      title={
        incoming
          ? t('transfers.requestSheet.askedYou', { name: firstName })
          : t('transfers.requestSheet.youAsked')
      }
    >
      <View style={{ gap: spacing[4] }}>
        <View style={[styles.row, { gap: spacing[3] }]}>
          <Avatar name={other.name} size="lg" ring />
          <View style={styles.flex}>
            <Text variant="bodyStrong">{other.name}</Text>
            {other.nemtag && (
              <Text variant="bodySmall" color="textMuted">
                @{other.nemtag}
              </Text>
            )}
          </View>
          <Badge label={status.label} tone={status.tone} />
        </View>

        <Card>
          <View style={{ gap: spacing[3] }}>
            <Row label={t('common.amount')} value={amount} />
            <Row
              label={t('transfers.requestSheet.for')}
              value={request.note || t('transfers.requests.noNote')}
            />
            <Row
              label={t('transfers.requestSheet.asked')}
              value={formatDateTime(request.created_at)}
            />
            {open ? (
              <Row
                label={t('transfers.requestSheet.expires')}
                value={expiresIn(request.expires_at)}
              />
            ) : request.responded_at ? (
              <Row label={status.label} value={formatDateTime(request.responded_at)} />
            ) : null}
            {request.split_bill_id && (
              <Row
                label={t('transfers.requestSheet.partOf')}
                value={t('transfers.requestSheet.splitBill')}
              />
            )}
          </View>
        </Card>

        {open && incoming && (
          <>
            <Button
              label={t('transfers.requestSheet.pay', { amount })}
              icon={Send}
              onPress={() => onPay(request)}
            />
            <Button
              label={t('transfers.requestSheet.decline')}
              icon={Ban}
              variant="ghost"
              onPress={() => setConfirm(true)}
            />
            <Text variant="caption" color="textMuted">
              {t('transfers.requestSheet.safety')}
            </Text>
          </>
        )}
        {open && !incoming && (
          <>
            <Button
              label={t('transfers.requestSheet.cancel')}
              icon={XCircle}
              variant="ghost"
              onPress={() => setConfirm(true)}
            />
            <Text variant="caption" color="textMuted">
              {t('transfers.requestSheet.theySee', { name: firstName })}
            </Text>
          </>
        )}

        {error && (
          <Text variant="bodySmall" color="danger" accessibilityLiveRegion="assertive">
            {error}
          </Text>
        )}
      </View>

      <Dialog
        open={confirm}
        title={
          incoming
            ? t('transfers.requestSheet.declineTitle', { name: firstName })
            : t('transfers.requestSheet.cancelTitle')
        }
        message={
          incoming
            ? t('transfers.requestSheet.declineMessage', { name: firstName })
            : t('transfers.requestSheet.cancelMessage', { name: firstName })
        }
        confirmLabel={
          incoming ? t('transfers.requestSheet.decline') : t('transfers.requestSheet.cancel')
        }
        cancelLabel={t('common.keepIt')}
        destructive
        loading={close.isPending}
        onConfirm={closeIt}
        onCancel={() => setConfirm(false)}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  between: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  value: { flexShrink: 1, textAlign: 'right' },
  flex: { flex: 1 },
});
