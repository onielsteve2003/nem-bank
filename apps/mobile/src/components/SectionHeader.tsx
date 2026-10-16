import { ChevronRight } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Button } from './Button';
import { Text } from './Text';

export type Props = {
  title: string;
  /** Optional trailing link, e.g. "See all". */
  actionLabel?: string;
  onAction?: () => void;
  /** Defaults to "<action>, <title>" so "See all" is announced with what it opens. */
  actionAccessibilityLabel?: string;
};

export function SectionHeader({ title, actionLabel, onAction, actionAccessibilityLabel }: Props) {
  return (
    <View style={styles.row}>
      <Text variant="h3" style={styles.flex} numberOfLines={1}>
        {title}
      </Text>
      {actionLabel && onAction && (
        <Button
          label={actionLabel}
          accessibilityLabel={actionAccessibilityLabel ?? `${actionLabel}, ${title}`}
          variant="ghost"
          size="sm"
          icon={ChevronRight}
          iconPosition="trailing"
          haptic="selection"
          onPress={onAction}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  flex: { flex: 1 },
});
