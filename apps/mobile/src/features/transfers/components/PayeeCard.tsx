import type { Schema } from '@nem/contracts';
import { CircleCheck, CircleX, TriangleAlert } from '@/components/icons';
import { StyleSheet, View } from 'react-native';

import { Avatar, Badge, Card, Checkbox, Icon, Text, TONE_PALETTE } from '@/components';
import { useTheme } from '@/theme';

import { copVerdict } from '../recipient';
import { useTranslation } from 'react-i18next';

type Payee = Schema<'ResolvedPayee'>;

const VERDICT_ICON = { success: CircleCheck, warning: TriangleAlert, danger: CircleX } as const;

/**
 * The person the bank found, and for other banks how their name compares with
 * the one typed (TRF-3). A "no match" needs a tick before the payment goes on.
 */
export function PayeeCard({
  payee,
  acknowledged,
  onAcknowledge,
}: {
  payee: Payee;
  acknowledged: boolean;
  onAcknowledge: (checked: boolean) => void;
}) {
  const { colors, radius, spacing } = useTheme();
  const { t } = useTranslation();
  const verdict = payee.name_match ? copVerdict(payee.name_match, payee.name) : null;
  const where =
    payee.kind === 'nem' && payee.nemtag
      ? t('transfers.payee.nemUser', { nemtag: payee.nemtag })
      : `${payee.bank_name} · ${payee.account_number}`;

  return (
    <Card>
      <View style={{ gap: spacing[3] }}>
        <View style={[styles.row, { gap: spacing[3] }]}>
          <Avatar name={payee.name} size="lg" ring={payee.kind === 'nem'} />
          <View style={styles.flex}>
            <Text
              variant="bodyStrong"
              accessibilityLabel={t('transfers.payee.accountName', { name: payee.name })}
            >
              {payee.name}
            </Text>
            <Text variant="bodySmall" color="textMuted">
              {where}
            </Text>
          </View>
          {payee.is_saved_beneficiary && (
            <Badge label={t('transfers.payee.saved')} tone="primary" />
          )}
        </View>
        {payee.kind === 'nem' && (
          <Text variant="bodySmall" color="textMuted">
            {t('transfers.payee.instant')}
          </Text>
        )}
        {verdict && (
          <View
            accessible
            accessibilityRole="alert"
            accessibilityLabel={`${verdict.title}. ${verdict.message}`}
            style={[
              styles.row,
              styles.top,
              {
                gap: spacing[2],
                padding: spacing[3],
                borderRadius: radius.md,
                backgroundColor: colors[TONE_PALETTE[verdict.tone].fill],
              },
            ]}
          >
            <Icon icon={VERDICT_ICON[verdict.tone]} color={TONE_PALETTE[verdict.tone].fg} />
            <View style={[styles.flex, { gap: spacing[1] }]}>
              <Text variant="bodyStrong" style={{ color: colors[TONE_PALETTE[verdict.tone].fg] }}>
                {verdict.title}
              </Text>
              <Text variant="bodySmall" style={{ color: colors[TONE_PALETTE[verdict.tone].fg] }}>
                {verdict.message}
              </Text>
            </View>
          </View>
        )}
        {verdict?.needsAcknowledgement && (
          <Checkbox
            label={t('transfers.payee.acknowledge', { name: payee.name })}
            checked={acknowledged}
            onChange={onAcknowledge}
          />
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  top: { alignItems: 'flex-start' },
  flex: { flex: 1 },
});
