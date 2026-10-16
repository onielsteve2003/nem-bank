import { useRouter } from 'expo-router';
import { ArrowLeft, ArrowRight, Moon, Plus, Send, Sun, Trash2 } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, IconButton, Text } from '@/components';
import { useTheme } from '@/theme';

// Dev preview of the component kit as it is built. T2.14 turns this into the
// full gallery with every component in both themes.

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing[3] }}>
      <Text variant="h3">{title}</Text>
      {children}
    </View>
  );
}

export function KitScreen() {
  const router = useRouter();
  const { colors, spacing, scheme, setPreference } = useTheme();
  const [loading, setLoading] = useState(false);

  const fakeSubmit = () => {
    setLoading(true);
    setTimeout(() => setLoading(false), 1500);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { padding: spacing[4] }]}>
        <IconButton
          icon={ArrowLeft}
          accessibilityLabel="Back"
          variant="ghost"
          onPress={router.back}
        />
        <Text variant="title">Component kit</Text>
        <IconButton
          icon={scheme === 'dark' ? Sun : Moon}
          accessibilityLabel={scheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onPress={() => setPreference(scheme === 'dark' ? 'light' : 'dark')}
        />
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing[4], gap: spacing[8] }}>
        <Section title="Buttons">
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
        </Section>
        <Section title="Icon buttons">
          <View style={[styles.row, { gap: spacing[3] }]}>
            <IconButton icon={Plus} accessibilityLabel="Add" variant="primary" size="lg" />
            <IconButton icon={Send} accessibilityLabel="Send" />
            <IconButton icon={ArrowRight} accessibilityLabel="Next" variant="ghost" />
            <IconButton icon={Trash2} accessibilityLabel="Delete" variant="danger" size="sm" />
            <IconButton icon={Plus} accessibilityLabel="Add (disabled)" disabled />
          </View>
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
});
