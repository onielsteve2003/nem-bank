import type { LucideIcon } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { Button } from './Button';
import { Icon } from './Icon';
import { Text } from './Text';

export type Props = {
  icon: LucideIcon;
  title: string;
  message?: string;
  /** The obvious next step, e.g. "Add money" on an empty wallet. */
  actionLabel?: string;
  onAction?: () => void;
  /** Muted icon for empty data; danger for errors. */
  tone?: 'neutral' | 'danger';
  /** Extra content under the message, such as a busy action button. */
  children?: React.ReactNode;
};

/** A centred illustration-free state: icon, title, message and one action. */
export function EmptyState({
  icon,
  title,
  message,
  actionLabel,
  onAction,
  tone = 'neutral',
  children,
}: Props) {
  const { colors, radius, spacing } = useTheme();

  return (
    <View style={[styles.base, { gap: spacing[3], padding: spacing[6] }]}>
      <View
        style={[
          styles.iconWrap,
          { borderRadius: radius.pill, backgroundColor: colors.raised, marginBottom: spacing[1] },
        ]}
      >
        <Icon icon={icon} size="xl" color={tone === 'danger' ? 'danger' : 'textMuted'} />
      </View>
      <Text variant="h3" align="center">
        {title}
      </Text>
      {message && (
        <Text color="textMuted" align="center">
          {message}
        </Text>
      )}
      {actionLabel && onAction && (
        <Button label={actionLabel} variant="secondary" onPress={onAction} style={styles.action} />
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: { alignItems: 'center', justifyContent: 'center' },
  iconWrap: { width: 72, height: 72, alignItems: 'center', justifyContent: 'center' },
  action: { alignSelf: 'center' },
});
