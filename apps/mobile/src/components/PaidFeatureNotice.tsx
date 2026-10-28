import { LockKeyhole } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { BottomSheet } from './BottomSheet';
import { Button } from './Button';
import { Icon } from './Icon';
import { Text } from './Text';

export type PaidFeature =
  | 'smsOtp'
  | 'ussd'
  | 'internationalTransfer'
  | 'physicalCard'
  | 'identityVerification'
  | 'realMoney';

/** The features PRD §11 gates, with the partner each needs and how the hookup would work. */
export const PAID_FEATURES: Record<
  PaidFeature,
  { name: string; partner: string; steps: readonly string[] }
> = {
  smsOtp: {
    name: 'SMS one-time codes',
    partner: 'a paid SMS gateway',
    steps: [
      'The Mailer interface gains an SMS adapter for a Nigerian SMS gateway.',
      'Codes are sent from a registered sender ID, with delivery receipts tracked.',
      'Until then, codes go by email and trusted devices sign in with device keys.',
    ],
  },
  ussd: {
    name: 'USSD banking',
    partner: 'a licensed USSD aggregator and a shortcode',
    steps: [
      'A USSD aggregator forwards each session to a Nem Bank menu service.',
      'The menu calls the same transfer and balance APIs as the app.',
      'Every money action still needs the account PIN.',
    ],
  },
  internationalTransfer: {
    name: 'International transfers',
    partner: 'a licensed remittance partner',
    steps: [
      'The BankPartner interface gains an adapter for a remittance provider.',
      'Quotes come from the partner, and the FX leg books through the same ledger.',
      'Compliance checks run on the partner side before money leaves.',
    ],
  },
  physicalCard: {
    name: 'Physical cards',
    partner: 'a card issuer and a card printing bureau',
    steps: [
      'The CardProcessor interface gains an adapter for a licensed issuer.',
      'The card is printed, posted and activated in the app with the PIN.',
      'Virtual cards already use the same freeze, limit and channel controls.',
    ],
  },
  identityVerification: {
    name: 'Real BVN and NIN checks',
    partner: 'a licensed identity verification provider',
    steps: [
      'The IdentityVerifier interface gains an adapter for a provider with NIBSS and NIMC access.',
      'The number, name and date of birth are checked live, and the number is stored encrypted.',
      'Until then, the bank accepts sandbox test numbers only.',
    ],
  },
  realMoney: {
    name: 'Real money accounts',
    partner: 'a licensed banking-as-a-service partner',
    steps: [
      'A BaaS partner holds the real accounts; Nem Bank keeps its own ledger in sync.',
      'KYC moves from sandbox test numbers to live BVN and NIN checks.',
      'The switch is a console feature flag, so no app code changes.',
    ],
  },
};

export type Props = {
  open: boolean;
  onClose: () => void;
  feature: PaidFeature;
};

/** The bottom sheet every paid feature opens instead of failing silently (PRD §11, ADR-7). */
export function PaidFeatureNotice({ open, onClose, feature }: Props) {
  const { colors, radius, spacing } = useTheme();
  const [explaining, setExplaining] = useState(false);
  const { name, partner, steps } = PAID_FEATURES[feature];

  // Every opening starts on the notice, not on the explainer left from last time.
  const close = () => {
    setExplaining(false);
    onClose();
  };

  return (
    <BottomSheet
      open={open}
      onClose={close}
      title={explaining ? 'How it would work' : 'This feature needs a paid partner service'}
    >
      {explaining ? (
        <View accessibilityRole="list" style={{ gap: spacing[3] }}>
          {steps.map((step, i) => (
            <View key={step} accessibilityRole="text" style={[styles.row, { gap: spacing[3] }]}>
              <View
                style={[styles.step, { backgroundColor: colors.raised, borderRadius: radius.pill }]}
              >
                <Text variant="caption" accessibilityLabel={`Step ${i + 1}`}>
                  {i + 1}
                </Text>
              </View>
              <Text variant="body" style={styles.flex}>
                {step}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <View style={[styles.row, { gap: spacing[3] }]}>
          <Icon icon={LockKeyhole} color="warning" />
          <Text variant="body" style={styles.flex}>
            {name} requires {partner}. Nem Bank is a portfolio project running on simulated money,
            so this connection is fully designed but switched off. It will be enabled once there is
            funding for the service.
          </Text>
        </View>
      )}
      <Button label="Got it" fullWidth onPress={close} />
      {explaining ? (
        <Button label="Back" variant="ghost" fullWidth onPress={() => setExplaining(false)} />
      ) : (
        <Button
          label="See how it would work"
          variant="secondary"
          fullWidth
          onPress={() => setExplaining(true)}
        />
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  flex: { flex: 1 },
  step: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
});
