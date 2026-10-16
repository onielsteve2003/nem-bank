import { useRouter } from 'expo-router';
import { ArrowLeft, Moon, Sun } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { IconButton, Screen, Text } from '@/components';
import { useTheme } from '@/theme';

import { ButtonsSection } from './ButtonsSection';
import { CardSection } from './CardSection';
import { ChartsSection } from './ChartsSection';
import { DisplaySection } from './DisplaySection';
import { FormsSection } from './FormsSection';
import { KeypadSection } from './KeypadSection';
import { MoneySection } from './MoneySection';
import { OverlaysSection } from './OverlaysSection';
import { SpecialSection } from './SpecialSection';
import { StatesSection } from './StatesSection';

// Dev preview of the component kit as it is built. T2.14 turns this into the
// full gallery with every component in both themes.

export function KitScreen() {
  const router = useRouter();
  const { spacing, scheme, setPreference } = useTheme();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = () => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1000);
  };

  return (
    <Screen
      refreshing={refreshing}
      onRefresh={refresh}
      contentContainerStyle={{ gap: spacing[8] }}
      header={
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
            accessibilityLabel={
              scheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
            }
            onPress={() => setPreference(scheme === 'dark' ? 'light' : 'dark')}
          />
        </View>
      }
    >
      <ButtonsSection />
      <MoneySection />
      <SpecialSection />
      <CardSection />
      <ChartsSection />
      <DisplaySection />
      <OverlaysSection />
      <StatesSection />
      <FormsSection />
      <KeypadSection />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
