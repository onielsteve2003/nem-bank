import { StyleSheet, View } from 'react-native';

import { Text } from '@/components';

/** A label on the left and its value on the right, for detail cards. */
export function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.between}>
      <Text color="textMuted">{label}</Text>
      <Text variant="bodyStrong">{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
