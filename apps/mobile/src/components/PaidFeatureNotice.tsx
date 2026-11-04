import { LockKeyhole } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import i18n from '@/lib/i18n';
import { useTheme } from '@/theme';

import { BottomSheet } from './BottomSheet';
import { Button } from './Button';
import { Icon } from './Icon';
import { Text } from './Text';

/** The features PRD §11 gates. */
export const PAID_FEATURES = [
  'smsOtp',
  'ussd',
  'internationalTransfer',
  'physicalCard',
  'identityVerification',
  'realMoney',
] as const;
export type PaidFeature = (typeof PAID_FEATURES)[number];

/** A gated feature, the partner it needs and how the hookup would work, in the current language. */
export function paidFeature(feature: PaidFeature): {
  name: string;
  partner: string;
  steps: readonly string[];
} {
  const key = `components.paid.features.${feature}` as const;
  return {
    name: i18n.t(`${key}.name`),
    partner: i18n.t(`${key}.partner`),
    steps: i18n.t(`${key}.steps`, { returnObjects: true }),
  };
}

export type Props = {
  open: boolean;
  onClose: () => void;
  feature: PaidFeature;
};

/** The bottom sheet every paid feature opens instead of failing silently (PRD §11, ADR-7). */
export function PaidFeatureNotice({ open, onClose, feature }: Props) {
  const { colors, radius, spacing } = useTheme();
  const { t } = useTranslation();
  const [explaining, setExplaining] = useState(false);
  const { name, partner, steps } = paidFeature(feature);

  // Every opening starts on the notice, not on the explainer left from last time.
  const close = () => {
    setExplaining(false);
    onClose();
  };

  return (
    <BottomSheet
      open={open}
      onClose={close}
      title={t(explaining ? 'components.paid.howTitle' : 'components.paid.title')}
    >
      {explaining ? (
        <View accessibilityRole="list" style={{ gap: spacing[3] }}>
          {steps.map((step, i) => (
            <View key={step} accessibilityRole="text" style={[styles.row, { gap: spacing[3] }]}>
              <View
                style={[styles.step, { backgroundColor: colors.raised, borderRadius: radius.pill }]}
              >
                <Text
                  variant="caption"
                  accessibilityLabel={t('components.paid.step', { n: i + 1 })}
                >
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
            {t('components.paid.body', { name, partner })}
          </Text>
        </View>
      )}
      <Button label={t('components.paid.gotIt')} fullWidth onPress={close} />
      {explaining ? (
        <Button
          label={t('common.back')}
          variant="ghost"
          fullWidth
          onPress={() => setExplaining(false)}
        />
      ) : (
        <Button
          label={t('components.paid.seeHow')}
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
