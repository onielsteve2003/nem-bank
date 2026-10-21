import { useLocalSearchParams, useRouter } from 'expo-router';
import { ArrowLeftRight, BellPlus } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Chip, ErrorState, Screen, SectionHeader, Text, useToast } from '@/components';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { AlertList } from '../components/AlertList';
import { CreateAlertSheet } from '../components/CreateAlertSheet';
import { RateChartCard } from '../components/RateChartCard';
import { alertTitle, PAIRS, pairLabel } from '../rates';

/**
 * Rates and rate alerts (FX-2): each pair's mid-market chart over 1D to 1Y and
 * the alerts that say when a rate crosses a number the customer picked.
 */
export function RatesScreen() {
  const router = useRouter();
  const toast = useToast();
  const { spacing } = useTheme();
  const params = useLocalSearchParams<{ pair?: string }>();
  const [pair, setPair] = useState(
    () => PAIRS.find((p) => p.pair === params.pair)?.pair ?? PAIRS[0]!.pair,
  );
  const [creating, setCreating] = useState(false);
  const rates = useRepoQuery('fx', 'listRates');
  const rate = rates.data?.data.find((r) => r.pair === pair);

  return (
    <Screen header={<SendHeader title="Rates and alerts" />} edges={['top', 'bottom']}>
      <View style={[styles.row, { gap: spacing[2] }]} accessibilityRole="tablist">
        {PAIRS.map((p) => (
          <Chip
            key={p.pair}
            label={pairLabel(p.pair)}
            selected={p.pair === pair}
            onPress={() => setPair(p.pair)}
          />
        ))}
      </View>

      {rates.isError ? (
        <ErrorState title="We couldn't load rates" onRetry={() => rates.refetch()} />
      ) : (
        <RateChartCard pair={pair} rate={rate} />
      )}
      <Text variant="caption" color="textMuted" style={styles.center}>
        Indicative mid-market rates. Your rate includes a spread, shown before you convert.
      </Text>
      <Button
        label={`Convert ${pair.split('-')[0]}`}
        icon={ArrowLeftRight}
        variant="secondary"
        onPress={() => router.dismissTo('/convert')}
      />

      <SectionHeader title="Rate alerts" />
      <AlertList onCreate={() => setCreating(true)} />
      <Button
        label={`New alert for ${pairLabel(pair)}`}
        icon={BellPlus}
        variant="ghost"
        onPress={() => setCreating(true)}
      />

      <CreateAlertSheet
        open={creating}
        pair={pair}
        midRate={rate?.mid_rate}
        onClose={() => setCreating(false)}
        onCreated={(alert) => {
          setCreating(false);
          toast.show({ message: `We'll tell you when ${alertTitle(alert)}`, tone: 'success' });
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap' },
  center: { textAlign: 'center' },
});
