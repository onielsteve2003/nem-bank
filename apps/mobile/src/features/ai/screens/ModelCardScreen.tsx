import { useLocalSearchParams } from 'expo-router';
import { Ban, Check, Info } from 'lucide-react-native';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { AIBadge, Card, EmptyState, Icon, Screen, SectionHeader, Switch, Text } from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { usePreferencesStore } from '@/stores';
import { useTheme } from '@/theme';

import { aiFeatureBySlug } from '../aiFeatures';
import { useAiToggle } from '../useAiToggle';

function Bullets({ items, icon = Info }: { items: string[]; icon?: typeof Info }) {
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
  const f = aiFeatureBySlug(slug ?? '');
  const ai = usePreferencesStore((s) => s.ai);
  const toggle = useAiToggle();

  if (!f) {
    return (
      <Screen header={<SendHeader title="AI feature" />} edges={['top', 'bottom']}>
        <EmptyState
          icon={Info}
          title="We can't find that feature"
          message="Go back to see them all."
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
          label="Use AI"
          accessibilityLabel={`Use AI for ${f.name}`}
          description={f.toggle ? undefined : 'Always on, to protect every payment'}
          value={on}
          disabled={!f.toggle}
          onValueChange={(next) => f.toggle && toggle(f.toggle, next)}
        />
        <Fact
          label={on ? 'If the model is unavailable' : 'What you get instead'}
          value={f.fallback}
          style={{ marginTop: spacing[2] }}
        />
      </Card>

      <View style={gap}>
        <SectionHeader title="What it uses" />
        <Card>
          <Bullets items={f.uses} icon={Check} />
        </Card>
      </View>
      <View style={gap}>
        <SectionHeader title="What it never uses" />
        <Card>
          <Bullets items={f.neverUses} icon={Ban} />
        </Card>
      </View>

      <View style={gap}>
        <SectionHeader title="Model card" />
        <Card>
          <View style={{ gap: spacing[3] }}>
            <Fact label="Where it runs" value={f.runsOn} />
            <Fact label="How it works" value={f.card.approach} />
            <View>
              <Text variant="caption" color="textMuted">
                Training data
              </Text>
              <Bullets items={f.card.data} />
            </View>
            <Fact label="Must beat" value={f.card.baseline} />
            <Fact
              label="Measured results"
              value="Published here with held-out metrics when the model ships with the live backend. The demo runs the fallback rules, so it claims no accuracy."
            />
            <View>
              <Text variant="caption" color="textMuted">
                Limitations
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
