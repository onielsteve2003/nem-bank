import { FlaskConical } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { Icon } from './Icon';
import { Text } from './Text';

export type Props = {
  /** "sandbox" for flows that run against a partner's test environment. */
  mode?: 'demo' | 'sandbox';
};

const COPY = {
  demo: { label: 'Demo money', spoken: 'Demo money. These balances are simulated.' },
  sandbox: {
    label: 'Sandbox',
    spoken: 'Sandbox. This runs on a test environment, not real money.',
  },
} as const;

/** Shown wherever balances appear, so simulated money is never mistaken for real (DEMO-2). */
export function DemoMoneyBadge({ mode = 'demo' }: Props) {
  const { colors, radius, spacing } = useTheme();
  const copy = COPY[mode];

  return (
    <View
      accessible
      accessibilityLabel={copy.spoken}
      style={[
        styles.pill,
        {
          gap: spacing[1],
          paddingHorizontal: spacing[2],
          borderRadius: radius.pill,
          borderColor: colors.warning,
        },
      ]}
    >
      <Icon icon={FlaskConical} size="sm" color="warning" />
      <Text variant="caption" color="warning" maxFontSizeMultiplier={1.4}>
        {copy.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    minHeight: 24,
    borderWidth: 1,
    borderStyle: 'dashed',
  },
});
