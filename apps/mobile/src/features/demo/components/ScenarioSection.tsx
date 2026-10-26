import { CalendarClock, LogOut, OctagonX } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { formatMoney } from '@nem/shared';

import { Button, Chip, Text, useToast } from '@/components';
import { useRepositories, type ApiError } from '@/data';
import { projectGoalsInterest } from '@/features/savings/projection';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useSessionStore } from '@/stores';
import { useTheme } from '@/theme';

import { TIME_TRAVEL_DAYS } from '../presets';
import { describeTravel, snapshot } from '../timeTravel';

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
  const [outcome, setOutcome] = useState<string>();
  const repos = useRepositories();
  const goals = useRepoQuery('savings', 'listGoals');
  const projected = goals.data ? projectGoalsInterest(goals.data.data, days) : null;

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
  });
  // Savings interest, locks and ajo turns are read either side of the jump, so
  // the demo can say what moving the clock actually did.
  const jump = async () => {
    setOutcome(undefined);
    const before = await snapshot(repos);
    const result = await travel.mutateAsync({ body: { days } });
    setClock(result);
    setOutcome(describeTravel(before, await snapshot(repos)));
    toast.show({
      message: `It is now ${dateFormat.format(new Date(result.now))}`,
      tone: 'success',
    });
  };

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
        {projected && projected.amount > 0n && (
          <Text variant="bodySmall" color="textMuted">
            Your savings goals would earn about {formatMoney(projected)} in interest. Ajo turns,
            auto-saves and locks that fall due run too.
          </Text>
        )}
        {clock && (
          <View style={{ gap: spacing[1] }} accessibilityLiveRegion="polite">
            <Text variant="bodySmall" color="textMuted">
              Demo date {dateFormat.format(new Date(clock.now))}, {clock.offset_days} days ahead
            </Text>
            {outcome && <Text variant="bodySmall">{outcome}</Text>}
          </View>
        )}
        <Button
          label={`Jump ${days === 1 ? '1 day' : `${days} days`} ahead`}
          icon={CalendarClock}
          variant="secondary"
          loading={travel.isPending}
          onPress={() => void jump().catch(() => undefined)}
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
