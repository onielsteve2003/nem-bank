import { RotateCcw } from 'lucide-react-native';

import { Button, Chip, Switch } from '@/components';
import { useDemoStore } from '@/stores';

import { ERROR_RATES, LATENCIES } from '../presets';

import { ChipRow, DemoSection } from './DemoSection';

/**
 * The mock bank's network (T3.8): how slow it is, how often it fails, and
 * whether it is reachable at all. Saved, so a demo set up flaky stays flaky.
 */
export function NetworkSection() {
  const simulation = useDemoStore((s) => s.simulation);
  const setSimulation = useDemoStore((s) => s.setSimulation);
  const resetSimulation = useDemoStore((s) => s.resetSimulation);

  return (
    <DemoSection
      title="Network"
      description="See every loading, error and offline state without a real outage."
    >
      <ChipRow label="Speed">
        {LATENCIES.map(({ value, label }) => (
          <Chip
            key={value}
            label={label}
            selected={simulation.latency === value}
            onPress={() => setSimulation({ latency: value })}
          />
        ))}
      </ChipRow>
      <ChipRow label="Failed requests">
        {ERROR_RATES.map(({ value, label }) => (
          <Chip
            key={label}
            label={label}
            selected={simulation.errorRate === value}
            onPress={() => setSimulation({ errorRate: value })}
          />
        ))}
      </ChipRow>
      <Switch
        label="Bank offline"
        description="Saved balances stay readable; payments need a connection."
        value={simulation.offline}
        onValueChange={(offline) => setSimulation({ offline })}
      />
      <Switch
        label="Lose some responses"
        description="A payment goes through but the answer never arrives. Retrying must not pay twice."
        value={simulation.failAfterCommit}
        onValueChange={(failAfterCommit) => setSimulation({ failAfterCommit })}
      />
      <Switch
        label="Friends send money"
        description="Small transfers arrive now and then, live."
        value={simulation.ambientActivity}
        onValueChange={(ambientActivity) => setSimulation({ ambientActivity })}
      />
      <Button label="Reset network" icon={RotateCcw} variant="ghost" onPress={resetSimulation} />
    </DemoSection>
  );
}
