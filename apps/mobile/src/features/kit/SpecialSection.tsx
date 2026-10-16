import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  AIBadge,
  Button,
  Card,
  DemoMoneyBadge,
  PAID_FEATURES,
  PaidFeatureNotice,
  RiskReasonList,
  Text,
  useToast,
  type PaidFeature,
  type RiskReason,
} from '@/components';
import { useTheme } from '@/theme';

import { KitSection } from './KitSection';

const REASONS: RiskReason[] = [
  { code: 'NEW_BENEFICIARY', label: 'First transfer to this account', severity: 'medium' },
  { code: 'AMOUNT_SPIKE', label: '8× your usual transfer amount', severity: 'high' },
  { code: 'NIGHT_TIME', label: 'Sent between 1am and 4am', severity: 'low' },
];

const FEATURES = Object.keys(PAID_FEATURES) as PaidFeature[];

export function SpecialSection() {
  const { spacing } = useTheme();
  const toast = useToast();
  const [paid, setPaid] = useState<PaidFeature | null>(null);
  const [lastPaid, setLastPaid] = useState<PaidFeature>('internationalTransfer');

  return (
    <KitSection title="Special">
      <View style={[styles.wrap, { gap: spacing[2] }]}>
        <DemoMoneyBadge />
        <DemoMoneyBadge mode="sandbox" />
        <AIBadge
          feature="Spending insights"
          explanation="A small model groups your transactions by merchant and spots unusual spending. It runs on your account data only, with names and numbers removed."
          fallback="Fixed category rules group your spending instead."
          onManage={() => toast.show({ message: 'Settings come in M19' })}
        />
      </View>
      <Card>
        <RiskReasonList reasons={REASONS} />
      </Card>
      <RiskReasonList reasons={[]} />
      <Text variant="bodySmall" color="textMuted">
        Paid feature notices
      </Text>
      {FEATURES.map((f) => (
        <Button
          key={f}
          label={PAID_FEATURES[f].name}
          variant="secondary"
          size="sm"
          onPress={() => {
            setLastPaid(f);
            setPaid(f);
          }}
        />
      ))}
      {/* Kept mounted with the last feature so the sheet can animate closed. */}
      <PaidFeatureNotice open={paid !== null} onClose={() => setPaid(null)} feature={lastPaid} />
    </KitSection>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
});
