import { useRouter } from 'expo-router';
import { ArrowLeft, Moon, Sun } from 'lucide-react-native';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { IconButton, Text } from '@/components';
import { useTheme } from '@/theme';

import { ButtonsSection } from './ButtonsSection';
import { FormsSection } from './FormsSection';
import { KeypadSection } from './KeypadSection';

// Dev preview of the component kit as it is built. T2.14 turns this into the
// full gallery with every component in both themes.

export function KitScreen() {
  const router = useRouter();
  const { colors, spacing, scheme, setPreference } = useTheme();

  return (
    <SafeAreaView style={[styles.flex, { backgroundColor: colors.background }]}>
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
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: spacing[4], gap: spacing[8] }}
        >
          <ButtonsSection />
          <FormsSection />
          <KeypadSection />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
