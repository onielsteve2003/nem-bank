import { useRouter } from 'expo-router';
import { Bell, Bot, Monitor, Moon, ShieldAlert, Sun, type LucideIcon } from 'lucide-react-native';
import type { ParseKeys } from 'i18next';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { Card, Chip, Divider, ListItem, Screen, SectionHeader, Switch, Text } from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import {
  usePreferencesStore,
  usePrivacyStore,
  type Appearance,
  type AutoLockSeconds,
  type Language,
  type ReduceMotion,
} from '@/stores';
import { useTheme } from '@/theme';

import { useSavePreferences } from '../useSavePreferences';

const APPEARANCES: { value: Appearance; label: ParseKeys; icon: LucideIcon }[] = [
  { value: 'system', label: 'common.matchPhone', icon: Monitor },
  { value: 'dark', label: 'settings.dark', icon: Moon },
  { value: 'light', label: 'settings.light', icon: Sun },
];

const LANGUAGES: readonly Language[] = ['en', 'pcm'];

const AUTO_LOCK: readonly AutoLockSeconds[] = [30, 60, 120, 300];

const MOTION: { value: ReduceMotion; label: ParseKeys }[] = [
  { value: 'system', label: 'common.matchPhone' },
  { value: 'always', label: 'settings.alwaysReduce' },
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
 * Settings (SET-1..SET-4): appearance, language, privacy mode and auto-lock,
 * low-data mode, reduce motion, and the way to every alert setting.
 */
export function SettingsScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const save = useSavePreferences();
  const appearance = usePreferencesStore((s) => s.appearance);
  const language = usePreferencesStore((s) => s.language);
  const lowData = usePreferencesStore((s) => s.lowDataMode);
  const autoLock = usePreferencesStore((s) => s.autoLockSeconds);
  const reduceMotion = usePreferencesStore((s) => s.reduceMotion);
  const setReduceMotion = usePreferencesStore((s) => s.setReduceMotion);
  const hidden = usePrivacyStore((s) => s.balancesHidden);
  const { t } = useTranslation();
  const lockLabel = (seconds: AutoLockSeconds) =>
    seconds < 60
      ? t('settings.seconds', { count: seconds })
      : t('settings.minutes', { count: seconds / 60 });

  return (
    <Screen header={<SendHeader title={t('settings.title')} first />} edges={['top', 'bottom']}>
      <Group title={t('settings.appearance')}>
        <Text variant="bodyStrong">{t('settings.theme')}</Text>
        <ChipRow>
          {APPEARANCES.map((a) => (
            <Chip
              key={a.value}
              label={t(a.label)}
              icon={a.icon}
              selected={appearance === a.value}
              onPress={() => save({ appearance: a.value })}
            />
          ))}
        </ChipRow>
      </Group>

      <Group title={t('settings.language')} hint={t('settings.languageHint')}>
        <ChipRow>
          {LANGUAGES.map((l) => (
            <Chip
              key={l}
              label={t(`settings.languages.${l}`)}
              selected={language === l}
              onPress={() => save({ language: l })}
            />
          ))}
        </ChipRow>
      </Group>

      <Group title={t('settings.privacy')} hint={t('settings.privacyHint')}>
        <Switch
          label={t('settings.privacyMode')}
          description={t('settings.privacyModeHint')}
          value={hidden}
          onValueChange={(on) => save({ hideBalances: on })}
        />
        <Divider />
        <Text variant="bodyStrong">{t('settings.autoLock')}</Text>
        <ChipRow>
          {AUTO_LOCK.map((seconds) => (
            <Chip
              key={seconds}
              label={lockLabel(seconds)}
              selected={autoLock === seconds}
              onPress={() => save({ autoLockSeconds: seconds })}
            />
          ))}
        </ChipRow>
      </Group>

      <Group title={t('settings.data')}>
        <Switch
          label={t('settings.lowData')}
          description={t('settings.lowDataHint')}
          value={lowData}
          onValueChange={(on) => save({ lowDataMode: on })}
        />
      </Group>

      <Group title={t('settings.accessibility')} hint={t('settings.accessibilityHint')}>
        <Text variant="bodyStrong">{t('settings.reduceMotion')}</Text>
        <Text variant="bodySmall" color="textMuted">
          {t('settings.reduceMotionHint')}
        </Text>
        <ChipRow>
          {MOTION.map((m) => (
            <Chip
              key={m.value}
              label={t(m.label)}
              selected={reduceMotion === m.value}
              onPress={() => setReduceMotion(m.value)}
            />
          ))}
        </ChipRow>
      </Group>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title={t('settings.alerts')} />
        <Card padded={false}>
          <ListItem
            title={t('settings.notifications')}
            subtitle={t('settings.notificationsHint')}
            leading={Bell}
            onPress={() => router.push('/notifications/preferences')}
          />
          <Divider />
          <ListItem
            title={t('settings.securityAlerts')}
            subtitle={t('settings.securityAlertsHint')}
            leading={ShieldAlert}
            onPress={() => router.push('/security/alerts')}
          />
          <Divider />
          <ListItem
            title={t('settings.aiFeatures')}
            subtitle={t('settings.aiFeaturesHint')}
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
