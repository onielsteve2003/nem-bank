import { ArrowRight, Plus, Send, Trash2 } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, IconButton } from '@/components';
import { useTheme } from '@/theme';

import { KitSection } from './KitSection';

export function ButtonsSection() {
  const { spacing } = useTheme();
  const [loading, setLoading] = useState(false);

  const fakeSubmit = () => {
    setLoading(true);
    setTimeout(() => setLoading(false), 1500);
  };

  return (
    <>
      <KitSection title="Buttons">
        <Button label="Send money" icon={Send} fullWidth loading={loading} onPress={fakeSubmit} />
        <Button label="Add money" variant="secondary" icon={Plus} fullWidth />
        <Button label="View details" variant="ghost" icon={ArrowRight} iconPosition="trailing" />
        <Button label="Delete beneficiary" variant="danger" icon={Trash2} />
        <View style={[styles.row, { gap: spacing[2] }]}>
          <Button label="Small" size="sm" />
          <Button label="Medium" size="md" variant="secondary" />
          <Button label="Large" size="lg" variant="secondary" />
        </View>
        <Button label="Disabled" disabled fullWidth />
      </KitSection>
      <KitSection title="Icon buttons">
        <View style={[styles.row, { gap: spacing[3] }]}>
          <IconButton icon={Plus} accessibilityLabel="Add" variant="primary" size="lg" />
          <IconButton icon={Send} accessibilityLabel="Send" />
          <IconButton icon={ArrowRight} accessibilityLabel="Next" variant="ghost" />
          <IconButton icon={Trash2} accessibilityLabel="Delete" variant="danger" size="sm" />
          <IconButton icon={Plus} accessibilityLabel="Add (disabled)" disabled />
        </View>
      </KitSection>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
});
