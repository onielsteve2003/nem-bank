import { useRouter } from 'expo-router';
import { Bell, Bot, Monitor, Moon, ShieldAlert, Sun, type LucideIcon } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';

import { Card, Chip, Divider, ListItem, Screen, SectionHeader, Switch, Text } from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import {
  usePreferencesStore,
  usePrivacyStore,
  type Appearance,
  type AutoLockSeconds,
  type ReduceMotion,
} from '@/stores';
import { useTheme } from '@/theme';

import { useSavePreferences } from '../useSavePreferences';

const APPEARANCES: { value: Appearance; label: string; icon: LucideIcon }[] = [
  { value: 'system', label: 'Match phone', icon: Monitor },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
];

const AUTO_LOCK: { value: AutoLockSeconds; label: string }[] = [
  { value: 30, label: '30 sec' },
  { value: 60, label: '1 min' },
  { value: 120, label: '2 min' },
  { value: 300, label: '5 min' },
];

const MOTION: { value: ReduceMotion; label: string }[] = [
  { value: 'system', label: 'Match phone' },
  { value: 'always', label: 'Always reduce' },
];

function ChipRow({ children }: { children: React.ReactNode }) {
  const { spacing } = useTheme();
  return <View style={[styles.wrap, { gap: spacing[2] }]}>{children}</View>;
}

function Group({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing[2] }}>
      <SectionHeader title={title} />
      <Card>
        <View style={{ gap: spacing[3] }}>
          {children}
          {hint && (
            <Text variant="caption" color="textMuted">
              {hint}
            </Text>
          )}
        </View>
      </Card>
    </View>
  );
}

/**
 * Settings (SET-1, SET-3, SET-4): appearance, privacy mode and auto-lock,
 * low-data mode, reduce motion, and the way to every alert setting.
 */
export function SettingsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const save = useSavePreferences();
  const appearance = usePreferencesStore((s) => s.appearance);
  const lowData = usePreferencesStore((s) => s.lowDataMode);
  const autoLock = usePreferencesStore((s) => s.autoLockSeconds);
  const reduceMotion = usePreferencesStore((s) => s.reduceMotion);
  const setReduceMotion = usePreferencesStore((s) => s.setReduceMotion);
  const hidden = usePrivacyStore((s) => s.balancesHidden);

  return (
    <Screen header={<SendHeader title="Settings" first />} edges={['top', 'bottom']}>
      <Group title="Appearance">
        <Text variant="bodyStrong">Theme</Text>
        <ChipRow>
          {APPEARANCES.map((a) => (
            <Chip
              key={a.value}
              label={a.label}
              icon={a.icon}
              selected={appearance === a.value}
              onPress={() => save({ appearance: a.value })}
            />
          ))}
        </ChipRow>
      </Group>

      <Group
        title="Privacy"
        hint="You can also tap the eye on Home to show or hide amounts at any time."
      >
        <Switch
          label="Privacy mode"
          description="Hides balances and amounts everywhere, for using Nem in public"
          value={hidden}
          onValueChange={(on) => save({ hideBalances: on })}
        />
        <Divider />
        <Text variant="bodyStrong">Lock Nem after it's been in the background for</Text>
        <ChipRow>
          {AUTO_LOCK.map((o) => (
            <Chip
              key={o.value}
              label={o.label}
              selected={autoLock === o.value}
              onPress={() => save({ autoLockSeconds: o.value })}
            />
          ))}
        </ChipRow>
      </Group>

      <Group title="Data">
        <Switch
          label="Low-data mode"
          description="Photos and charts load only when you tap them, and lists fetch less at a time"
          value={lowData}
          onValueChange={(on) => save({ lowDataMode: on })}
        />
      </Group>

      <Group
        title="Accessibility"
        hint="Text size and the screen reader follow your phone's settings. Nem supports both."
      >
        <Text variant="bodyStrong">Reduce motion</Text>
        <Text variant="bodySmall" color="textMuted">
          Fewer animations: no card tilt, count-ups or springy buttons.
        </Text>
        <ChipRow>
          {MOTION.map((m) => (
            <Chip
              key={m.value}
              label={m.label}
              selected={reduceMotion === m.value}
              onPress={() => setReduceMotion(m.value)}
            />
          ))}
        </ChipRow>
      </Group>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title="Alerts" />
        <Card padded={false}>
          <ListItem
            title="Notifications"
            subtitle="What we tell you about, and where"
            leading={Bell}
            onPress={() => router.push('/notifications/preferences')}
          />
          <Divider />
          <ListItem
            title="Security alerts"
            subtitle="Sign-ins, new devices and large payments"
            leading={ShieldAlert}
            onPress={() => router.push('/security/alerts')}
          />
          <Divider />
          <ListItem
            title="AI features"
            subtitle="Switch each AI feature on or off"
            leading={Bot}
            onPress={() => router.push('/ai')}
          />
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
});
