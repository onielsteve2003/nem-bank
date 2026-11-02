import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { SelectSheet, TextField } from '@/components';
import { useTheme } from '@/theme';

import { addressProblems, NIGERIAN_STATES, type DeliveryAddress } from '../cards';

const STATE_OPTIONS = NIGERIAN_STATES.map((s) => ({ value: s, label: s }));

/** A Nigerian address, field by field, with problems shown as they are typed. */
export function AddressFields({
  value,
  onChange,
}: {
  value: DeliveryAddress;
  onChange: (next: DeliveryAddress) => void;
}) {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const problems = addressProblems(value);
  const set = (field: keyof DeliveryAddress) => (text: string) =>
    onChange({ ...value, [field]: text });

  return (
    <View style={{ gap: spacing[3] }}>
      <TextField
        label={t('cards.address.line1')}
        placeholder={t('cards.address.line1Placeholder')}
        value={value.line1}
        onChangeText={set('line1')}
        autoComplete="street-address"
        error={problems.line1}
      />
      <TextField
        label={t('cards.address.line2')}
        optional
        placeholder={t('cards.address.line2Placeholder')}
        value={value.line2}
        onChangeText={set('line2')}
      />
      <TextField
        label={t('cards.address.city')}
        placeholder={t('cards.address.cityPlaceholder')}
        value={value.city}
        onChangeText={set('city')}
        autoCapitalize="words"
        error={problems.city}
      />
      <SelectSheet
        label={t('cards.address.state')}
        title={t('cards.address.state')}
        placeholder={t('cards.address.statePlaceholder')}
        options={STATE_OPTIONS}
        value={value.state || null}
        onChange={set('state')}
      />
      <TextField
        label={t('cards.address.postalCode')}
        optional
        placeholder="106104"
        keyboardType="number-pad"
        maxLength={6}
        value={value.postalCode}
        onChangeText={set('postalCode')}
        error={problems.postalCode}
      />
    </View>
  );
}
