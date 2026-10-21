import { CircleCheck, Circle } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Card, Icon, Text } from '@/components';
import { useTheme } from '@/theme';

import { CARD_TYPES, type CardType } from '../cards';

export type Props = { value: CardType; onChange: (type: CardType) => void };

/** The three kinds of virtual card (CARD-1), each with what it is for. */
export function CardTypeOptions({ value, onChange }: Props) {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ gap: spacing[2] }} accessibilityRole="radiogroup">
      {(Object.keys(CARD_TYPES) as CardType[]).map((type) => {
        const selected = type === value;
        return (
          <Card
            key={type}
            variant="outline"
            accessibilityRole="radio"
            accessibilityLabel={`${CARD_TYPES[type].label}. ${CARD_TYPES[type].description}`}
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(type)}
            style={[
              styles.row,
              { gap: spacing[3] },
              selected && { borderColor: colors.primaryText },
            ]}
          >
            <Icon
              icon={selected ? CircleCheck : Circle}
              color={selected ? 'primaryText' : 'textMuted'}
            />
            <View style={styles.flex}>
              <Text variant="bodyStrong">{CARD_TYPES[type].label}</Text>
              <Text variant="bodySmall" color="textMuted">
                {CARD_TYPES[type].description}
              </Text>
            </View>
          </Card>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
