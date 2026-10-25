import type { ColorScheme } from '@nem/shared';
import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { useState, type ComponentType } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Chip, IconButton, Screen, Text } from '@/components';
import { ThemeProvider, useTheme } from '@/theme';

import { ButtonsSection } from './ButtonsSection';
import { CardSection } from './CardSection';
import { ChartsSection } from './ChartsSection';
import { DisplaySection } from './DisplaySection';
import { FormsSection } from './FormsSection';
import { FoundationsSection } from './FoundationsSection';
import { KeypadSection } from './KeypadSection';
import { MoneySection } from './MoneySection';
import { OverlaysSection } from './OverlaysSection';
import { SpecialSection } from './SpecialSection';
import { StatesSection } from './StatesSection';

// Dev-only Design System gallery: every component, in either theme or both.

export const GALLERY_SECTIONS: { key: string; label: string; Section: ComponentType }[] = [
  { key: 'foundations', label: 'Foundations', Section: FoundationsSection },
  { key: 'buttons', label: 'Buttons', Section: ButtonsSection },
  { key: 'money', label: 'Money', Section: MoneySection },
  { key: 'special', label: 'Special', Section: SpecialSection },
  { key: 'card', label: 'Card', Section: CardSection },
  { key: 'charts', label: 'Charts', Section: ChartsSection },
  { key: 'display', label: 'Display', Section: DisplaySection },
  { key: 'overlays', label: 'Overlays', Section: OverlaysSection },
  { key: 'states', label: 'States', Section: StatesSection },
  { key: 'forms', label: 'Forms', Section: FormsSection },
  { key: 'keypads', label: 'Keypads', Section: KeypadSection },
];

type ThemeMode = ColorScheme | 'both';

const THEME_MODES: { mode: ThemeMode; label: string }[] = [
  { mode: 'dark', label: 'Dark' },
  { mode: 'light', label: 'Light' },
  { mode: 'both', label: 'Both' },
];

export function KitScreen() {
  const router = useRouter();
  const { spacing, scheme, setPreference } = useTheme();
  const [both, setBoth] = useState(false);
  const [only, setOnly] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const mode: ThemeMode = both ? 'both' : scheme;
  const sections = GALLERY_SECTIONS.filter((s) => only === null || s.key === only);

  const chooseMode = (next: ThemeMode) => {
    setBoth(next === 'both');
    if (next !== 'both') setPreference(next);
  };

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
        <View style={{ gap: spacing[2], paddingVertical: spacing[2] }}>
          <View style={[styles.row, { paddingHorizontal: spacing[4], gap: spacing[2] }]}>
            <IconButton
              icon={ArrowLeft}
              accessibilityLabel="Back"
              variant="ghost"
              onPress={() => router.back()}
            />
            <Text variant="title" style={styles.flex}>
              Design system
            </Text>
          </View>
          <ChipRow>
            {THEME_MODES.map((m) => (
              <Chip
                key={m.mode}
                label={m.label}
                selected={mode === m.mode}
                onPress={() => chooseMode(m.mode)}
              />
            ))}
          </ChipRow>
          <ChipRow>
            <Chip label="All" selected={only === null} onPress={() => setOnly(null)} />
            {GALLERY_SECTIONS.map((s) => (
              <Chip
                key={s.key}
                label={s.label}
                selected={only === s.key}
                onPress={() => setOnly(s.key)}
              />
            ))}
          </ChipRow>
        </View>
      }
    >
      {sections.map(({ key, Section }) =>
        both ? (
          <View key={key} style={{ gap: spacing[3] }}>
            <ThemePanel scheme="dark" Section={Section} />
            <ThemePanel scheme="light" Section={Section} />
          </View>
        ) : (
          <Section key={key} />
        ),
      )}
    </Screen>
  );
}

function ChipRow({ children }: { children: React.ReactNode }) {
  const { spacing } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: spacing[2], paddingHorizontal: spacing[4] }}
    >
      {children}
    </ScrollView>
  );
}

/**
 * Renders a section under a fixed theme. Sheets and toasts portal to the app
 * root, so they follow the app theme rather than the panel's.
 */
function ThemePanel({ scheme, Section }: { scheme: ColorScheme; Section: ComponentType }) {
  return (
    <ThemeProvider initialPreference={scheme} syncSystemUI={false}>
      <PanelSurface scheme={scheme}>
        <Section />
      </PanelSurface>
    </ThemeProvider>
  );
}

function PanelSurface({ scheme, children }: { scheme: ColorScheme; children: React.ReactNode }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      style={{
        gap: spacing[2],
        padding: spacing[4],
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.background,
      }}
    >
      <Text variant="caption" color="textMuted">
        {scheme === 'dark' ? 'Dark theme' : 'Light theme'}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
