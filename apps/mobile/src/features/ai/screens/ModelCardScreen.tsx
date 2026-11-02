import { useLocalSearchParams } from 'expo-router';
import { Ban, Check, Info } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { AIBadge, Card, EmptyState, Icon, Screen, SectionHeader, Switch, Text } from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { usePreferencesStore } from '@/stores';
import { useTheme } from '@/theme';

import { aiFeatureBySlug } from '../aiFeatures';
import { useAiToggle } from '../useAiToggle';

function Bullets({ items, icon = Info }: { items: readonly string[]; icon?: typeof Info }) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing[2] }}>
      {items.map((item) => (
        <View key={item} style={[styles.row, { gap: spacing[2] }]}>
          <Icon icon={icon} size="sm" color={icon === Ban ? 'danger' : 'textMuted'} />
          <Text variant="bodySmall" style={styles.flex}>
            {item}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Fact({ label, value, style }: { label: string; value: string; style?: ViewStyle }) {
  return (
    <View style={style}>
      <Text variant="caption" color="textMuted">
        {label}
      </Text>
      <Text variant="bodySmall">{value}</Text>
    </View>
  );
}

/** One AI feature in full (AI-8): what it reads, where it runs, its model card and switch. */
export function ModelCardScreen() {
  const { feature: slug } = useLocalSearchParams<{ feature: string }>();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const f = aiFeatureBySlug(slug ?? '');
  const ai = usePreferencesStore((s) => s.ai);
  const toggle = useAiToggle();

  if (!f) {
    return (
      <Screen header={<SendHeader title={t('ai.card.title')} />} edges={['top', 'bottom']}>
        <EmptyState
          icon={Info}
          title={t('ai.card.notFound')}
          message={t('ai.card.notFoundMessage')}
        />
      </Screen>
    );
  }

  const on = f.toggle ? ai[f.toggle] : true;
  const gap = { gap: spacing[2] };

  return (
    <Screen header={<SendHeader title={f.name} />} edges={['top', 'bottom']}>
      <View style={[styles.row, styles.center, gap]}>
        <Text variant="body" style={styles.flex}>
          {f.summary}
        </Text>
        <AIBadge feature={f.name} explanation={f.summary} fallback={f.fallback} />
      </View>

      <Card>
        <Switch
          label={t('ai.transparency.useAi')}
          accessibilityLabel={t('ai.transparency.useAiFor', { name: f.name })}
          description={f.toggle ? undefined : t('ai.transparency.alwaysOn')}
          value={on}
          disabled={!f.toggle}
          onValueChange={(next) => f.toggle && toggle(f.toggle, next)}
        />
        <Fact
          label={t(on ? 'ai.card.unavailable' : 'ai.card.instead')}
          value={f.fallback}
          style={{ marginTop: spacing[2] }}
        />
      </Card>

      <View style={gap}>
        <SectionHeader title={t('ai.card.uses')} />
        <Card>
          <Bullets items={f.uses} icon={Check} />
        </Card>
      </View>
      <View style={gap}>
        <SectionHeader title={t('ai.card.neverUses')} />
        <Card>
          <Bullets items={f.neverUses} icon={Ban} />
        </Card>
      </View>

      <View style={gap}>
        <SectionHeader title={t('ai.card.modelCard')} />
        <Card>
          <View style={{ gap: spacing[3] }}>
            <Fact label={t('ai.card.runsOn')} value={f.runsOn} />
            <Fact label={t('ai.card.approach')} value={f.card.approach} />
            <View>
              <Text variant="caption" color="textMuted">
                {t('ai.card.data')}
              </Text>
              <Bullets items={f.card.data} />
            </View>
            <Fact label={t('ai.card.baseline')} value={f.card.baseline} />
            <Fact label={t('ai.card.results')} value={t('ai.card.resultsValue')} />
            <View>
              <Text variant="caption" color="textMuted">
                {t('ai.card.limitations')}
              </Text>
              <Bullets items={f.card.limitations} />
            </View>
          </View>
        </Card>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  center: { alignItems: 'center' },
  flex: { flex: 1 },
});
