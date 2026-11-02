import { useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { Card, Divider, Icon, ListItem, Screen, SectionHeader, Switch, Text } from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { usePreferencesStore } from '@/stores';
import { useTheme } from '@/theme';

import { AI_FEATURES, aiPrinciples } from '../aiFeatures';
import { useAiToggle } from '../useAiToggle';

/**
 * AI and your data (AI-8): every AI feature in Nem, in plain words, with its
 * switch and a link to its model card.
 */
export function AiTransparencyScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const ai = usePreferencesStore((s) => s.ai);
  const toggle = useAiToggle();

  return (
    <Screen header={<SendHeader title={t('ai.transparency.title')} />} edges={['top', 'bottom']}>
      <Card>
        <View style={{ gap: spacing[3] }}>
          {aiPrinciples().map((p) => (
            <View key={p} style={[styles.row, { gap: spacing[2] }]}>
              <Icon icon={Check} size="sm" color="success" />
              <Text variant="bodySmall" style={styles.flex}>
                {p}
              </Text>
            </View>
          ))}
        </View>
      </Card>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title={t('ai.transparency.features')} />
        {AI_FEATURES.map((f) => (
          <Card key={f.slug} padded={false}>
            <ListItem
              title={f.name}
              subtitle={f.summary}
              leading={f.icon}
              accessibilityHint={t('ai.transparency.hint')}
              onPress={() =>
                router.push({ pathname: '/ai/[feature]', params: { feature: f.slug } })
              }
            />
            <Divider />
            <View style={{ paddingHorizontal: spacing[4] }}>
              {f.toggle ? (
                <Switch
                  label={t('ai.transparency.useAi')}
                  accessibilityLabel={t('ai.transparency.useAiFor', { name: f.name })}
                  description={
                    ai[f.toggle] ? undefined : t('ai.transparency.off', { fallback: f.fallback })
                  }
                  value={ai[f.toggle]}
                  onValueChange={(on) => toggle(f.toggle!, on)}
                />
              ) : (
                <Switch
                  label={t('ai.transparency.useAi')}
                  accessibilityLabel={t('ai.transparency.useAiFor', { name: f.name })}
                  description={t('ai.transparency.alwaysOn')}
                  value
                  disabled
                  onValueChange={() => undefined}
                />
              )}
            </View>
          </Card>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  flex: { flex: 1 },
});
