import { RotateCcw } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';

import { Button, Chip, Switch } from '@/components';
import { useDemoStore } from '@/stores';

import { ERROR_RATES, LATENCIES } from '../presets';

import { ChipRow, DemoSection } from './DemoSection';

/**
 * The mock bank's network (T3.8): how slow it is, how often it fails, and
 * whether it is reachable at all. Saved, so a demo set up flaky stays flaky.
 */
export function NetworkSection() {
  const { t } = useTranslation();
  const simulation = useDemoStore((s) => s.simulation);
  const setSimulation = useDemoStore((s) => s.setSimulation);
  const resetSimulation = useDemoStore((s) => s.resetSimulation);

  return (
    <DemoSection title={t('demo.network.title')} description={t('demo.network.description')}>
      <ChipRow label={t('demo.network.speed')}>
        {LATENCIES.map((l) => (
          <Chip
            key={l.value}
            label={l.label}
            selected={simulation.latency === l.value}
            onPress={() => setSimulation({ latency: l.value })}
          />
        ))}
      </ChipRow>
      <ChipRow label={t('demo.network.failed')}>
        {ERROR_RATES.map((r) => (
          <Chip
            key={r.value}
            label={r.label}
            selected={simulation.errorRate === r.value}
            onPress={() => setSimulation({ errorRate: r.value })}
          />
        ))}
      </ChipRow>
      <Switch
        label={t('demo.network.offline')}
        description={t('demo.network.offlineHelp')}
        value={simulation.offline}
        onValueChange={(offline) => setSimulation({ offline })}
      />
      <Switch
        label={t('demo.network.lose')}
        description={t('demo.network.loseHelp')}
        value={simulation.failAfterCommit}
        onValueChange={(failAfterCommit) => setSimulation({ failAfterCommit })}
      />
      <Switch
        label={t('demo.network.friends')}
        description={t('demo.network.friendsHelp')}
        value={simulation.ambientActivity}
        onValueChange={(ambientActivity) => setSimulation({ ambientActivity })}
      />
      <Button
        label={t('demo.network.reset')}
        icon={RotateCcw}
        variant="ghost"
        onPress={resetSimulation}
      />
    </DemoSection>
  );
}
