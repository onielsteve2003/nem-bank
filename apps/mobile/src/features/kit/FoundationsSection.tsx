import { SPACING, type ColorTokens, type TypeVariant } from '@nem/shared';
import { ArrowUpRight, Bell, Send, Wallet } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Icon, ICON_SIZE, Text } from '@/components';
import { useTheme } from '@/theme';

import { KitSection } from './KitSection';

const TYPE_VARIANTS: TypeVariant[] = [
  'display',
  'h1',
  'h2',
  'h3',
  'title',
  'body',
  'bodyStrong',
  'bodySmall',
  'label',
  'caption',
  'amount',
];

const ICON_SIZES = Object.keys(ICON_SIZE) as (keyof typeof ICON_SIZE)[];
const SPACING_STEPS = Object.keys(SPACING)
  .map(Number)
  .filter((step) => step > 0) as (keyof typeof SPACING)[];

export function FoundationsSection() {
  const { colors, radius, spacing } = useTheme();
  const tokens = Object.keys(colors) as (keyof ColorTokens)[];

  return (
    <KitSection title="Foundations">
      <Text variant="label" color="textMuted">
        Colour
      </Text>
      <View style={[styles.wrap, { gap: spacing[2] }]}>
        {tokens.map((token) => (
          <View
            key={token}
            accessible
            accessibilityLabel={`${token}, ${colors[token]}`}
            style={[styles.swatch, { gap: spacing[1] }]}
          >
            <View
              style={[
                styles.chip,
                {
                  backgroundColor: colors[token],
                  borderColor: colors.border,
                  borderRadius: radius.md,
                },
              ]}
            />
            <Text variant="caption" numberOfLines={1}>
              {token}
            </Text>
            <Text variant="caption" color="textMuted">
              {colors[token].startsWith('#') ? colors[token] : 'rgba'}
            </Text>
          </View>
        ))}
      </View>

      <Text variant="label" color="textMuted">
        Type
      </Text>
      <View style={{ gap: spacing[2] }}>
        {TYPE_VARIANTS.map((variant) => (
          <View key={variant} style={[styles.row, { gap: spacing[3] }]}>
            <Text variant="caption" color="textMuted" style={styles.typeName}>
              {variant}
            </Text>
            <Text variant={variant} numberOfLines={1} style={styles.flex}>
              {variant === 'amount' ? '₦24,850.00' : 'Nem Bank'}
            </Text>
          </View>
        ))}
      </View>

      <Text variant="label" color="textMuted">
        Icons
      </Text>
      <View style={[styles.row, { gap: spacing[4] }]}>
        {ICON_SIZES.map((size) => (
          <View key={size} style={[styles.center, { gap: spacing[1] }]}>
            <Icon icon={Wallet} size={size} />
            <Text variant="caption" color="textMuted">
              {size}
            </Text>
          </View>
        ))}
        <Icon icon={Send} color="primaryText" />
        <Icon icon={ArrowUpRight} color="success" />
        <Icon icon={Bell} color="warning" accessibilityLabel="Notifications" />
      </View>

      <Text variant="label" color="textMuted">
        Spacing
      </Text>
      <View style={{ gap: spacing[1] }}>
        {SPACING_STEPS.map((step) => (
          <View key={step} style={[styles.row, { gap: spacing[3] }]}>
            <Text variant="caption" color="textMuted" style={styles.typeName}>
              {step} · {SPACING[step]}pt
            </Text>
            <View
              style={{
                width: SPACING[step],
                height: 8,
                borderRadius: radius.sm,
                backgroundColor: colors.primary,
              }}
            />
          </View>
        ))}
      </View>
    </KitSection>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center' },
  flex: { flex: 1 },
  swatch: { width: 96 },
  chip: { height: 40, borderWidth: StyleSheet.hairlineWidth },
  typeName: { width: 80 },
});
