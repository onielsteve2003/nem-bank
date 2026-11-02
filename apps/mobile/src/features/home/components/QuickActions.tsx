import {
  ArrowLeftRight,
  ArrowUpRight,
  Plus,
  Receipt,
  ScanLine,
  type LucideIcon,
} from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Icon, PressableScale, Text } from '@/components';
import { haptic } from '@/lib/haptics';
import { useTheme } from '@/theme';
import { useTranslation } from 'react-i18next';

export type QuickAction = 'send' | 'addMoney' | 'convert' | 'bills' | 'scan';

const ACTIONS: readonly { key: QuickAction; icon: LucideIcon }[] = [
  { key: 'send', icon: ArrowUpRight },
  { key: 'addMoney', icon: Plus },
  { key: 'convert', icon: ArrowLeftRight },
  { key: 'bills', icon: Receipt },
  { key: 'scan', icon: ScanLine },
];

const BUTTON = 52;

/** The five things people come to Home to do (PRD §8), one tap each. */
export function QuickActions({ onAction }: { onAction: (action: QuickAction) => void }) {
  const { colors, spacing } = useTheme();
  const { t } = useTranslation();
  return (
    <View style={[styles.row, { paddingHorizontal: spacing[4] }]}>
      {ACTIONS.map(({ key, icon }) => (
        <PressableScale
          key={key}
          accessibilityRole="button"
          accessibilityLabel={t(`home.actions.${key}`)}
          onPress={() => {
            haptic('tap');
            onAction(key);
          }}
          style={[styles.action, { gap: spacing[1] }]}
        >
          <View
            style={[
              styles.circle,
              {
                backgroundColor: key === 'send' ? colors.primary : colors.raised,
                borderColor: colors.border,
                borderWidth: key === 'send' ? 0 : StyleSheet.hairlineWidth,
              },
            ]}
          >
            <Icon icon={icon} size="md" color={key === 'send' ? 'onPrimary' : 'text'} />
          </View>
          <Text variant="caption" color="textMuted" numberOfLines={1}>
            {t(`home.actions.${key}`)}
          </Text>
        </PressableScale>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  action: { alignItems: 'center', minWidth: 60 },
  circle: {
    width: BUTTON,
    height: BUTTON,
    borderRadius: BUTTON / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
