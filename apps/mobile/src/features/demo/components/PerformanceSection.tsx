import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { Badge, Text } from '@/components';
import { STARTUP_TARGET_MS, timeToInteractive } from '@/lib/startup';
import { useTheme } from '@/theme';

import { DemoSection } from './DemoSection';

/** How long this launch took to reach Home, against the PRD's 2.5 s target. */
export function PerformanceSection() {
  const { t } = useTranslation();
  const { spacing } = useTheme();
  const ms = timeToInteractive();
  const within = ms !== null && ms <= STARTUP_TARGET_MS;

  return (
    <DemoSection
      title={t('demo.performance.title')}
      description={t('demo.performance.description')}
    >
      <View style={{ gap: spacing[1] }}>
        <Text variant="label" color="textMuted">
          {t('demo.performance.startup')}
        </Text>
        {ms === null ? (
          <Text variant="body">{t('demo.performance.notYet')}</Text>
        ) : (
          <View style={[styles.row, { gap: spacing[2] }]}>
            <Text variant="h3">
              {t('demo.performance.value', { seconds: (ms / 1000).toFixed(2) })}
            </Text>
            <Badge
              tone={within ? 'success' : 'warning'}
              label={within ? t('demo.performance.withinTarget') : t('demo.performance.overTarget')}
            />
          </View>
        )}
        <Text variant="caption" color="textMuted">
          {t('demo.performance.target', { target: STARTUP_TARGET_MS / 1000 })}
        </Text>
      </View>
    </DemoSection>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
});
