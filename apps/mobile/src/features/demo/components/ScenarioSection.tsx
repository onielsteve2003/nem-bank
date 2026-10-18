import { CalendarClock, LogOut, OctagonX } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Chip, Text, useToast } from '@/components';
import type { ApiError } from '@/data';
import { useRepoMutation } from '@/lib/query';
import { useSessionStore } from '@/stores';
import { useTheme } from '@/theme';

import { TIME_TRAVEL_DAYS } from '../presets';

import { ChipRow, DemoSection } from './DemoSection';

const dateFormat = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Scenarios that are hard to reach by hand: a failed bank transfer, the future, an ended session. */
export function ScenarioSection() {
  const { spacing } = useTheme();
  const toast = useToast();
  const [days, setDays] = useState<number>(TIME_TRAVEL_DAYS[1]);
  const [clock, setClock] = useState<{ now: string; offset_days: number } | null>(null);

  const onError = (error: ApiError) => toast.show({ message: error.problem.title, tone: 'error' });
  const failNext = useRepoMutation('demo', 'failNextTransfer', {
    invalidates: [],
    onError,
    onSuccess: () =>
      toast.show({
        message: 'Your next bank transfer will fail at the partner bank and be reversed.',
        tone: 'info',
      }),
  });
  // Interest, ajo cycles, schedules and due dates all move, so refresh everything.
  const travel = useRepoMutation('demo', 'timeTravel', {
    invalidates: [[]],
    onError,
    onSuccess: (result) => {
      setClock(result);
      toast.show({
        message: `It is now ${dateFormat.format(new Date(result.now))}`,
        tone: 'success',
      });
    },
  });

  return (
    <DemoSection title="Scenarios" description="Rehearse what is hard to make happen on purpose.">
      <Button
        label="Fail my next bank transfer"
        icon={OctagonX}
        variant="secondary"
        loading={failNext.isPending}
        onPress={() => failNext.mutate(undefined)}
      />
      <View style={{ gap: spacing[3] }}>
        <ChipRow label="Time travel">
          {TIME_TRAVEL_DAYS.map((d) => (
            <Chip
              key={d}
              label={d === 1 ? '1 day' : `${d} days`}
              selected={d === days}
              onPress={() => setDays(d)}
            />
          ))}
        </ChipRow>
        {clock && (
          <Text variant="bodySmall" color="textMuted" accessibilityLiveRegion="polite">
            Demo date {dateFormat.format(new Date(clock.now))}, {clock.offset_days} days ahead
          </Text>
        )}
        <Button
          label={`Jump ${days === 1 ? '1 day' : `${days} days`} ahead`}
          icon={CalendarClock}
          variant="secondary"
          loading={travel.isPending}
          onPress={() => travel.mutate({ body: { days } })}
        />
      </View>
      <Button
        label="End my session"
        icon={LogOut}
        variant="ghost"
        accessibilityHint="Signs you out as if the session had expired"
        onPress={() => useSessionStore.getState().expire()}
      />
    </DemoSection>
  );
}
