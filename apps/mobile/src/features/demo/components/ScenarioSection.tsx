import { CalendarClock, LogOut, OctagonX } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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

/** Words in demo.scenarios.review.<outcome>. */
const REVIEW_OUTCOMES = ['approve', 'reject', 'resubmit'] as const;

const dateFormat = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Scenarios that are hard to reach by hand: a failed bank transfer, the future, an ended session. */
export function ScenarioSection() {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const toast = useToast();
  const [days, setDays] = useState<number>(TIME_TRAVEL_DAYS[1]);
  const [clock, setClock] = useState<{ now: string; offset_days: number } | null>(null);
  const [outcome, setOutcome] = useState<string>();
  const repos = useRepositories();
  const goals = useRepoQuery('savings', 'listGoals');
  const me = useRepoQuery('users', 'getMe');
  const projected = goals.data ? projectGoalsInterest(goals.data.data, days) : null;

  const onError = (error: ApiError) => toast.show({ message: error.problem.title, tone: 'error' });
  // Limits, wallets, credit and the security checkup all follow the tier.
  const setTier = useRepoMutation('demo', 'setKycTier', {
    invalidates: [[]],
    onError,
    onSuccess: (_, { body }) =>
      toast.show({ message: t('demo.scenarios.tierNow', { tier: body.tier }), tone: 'success' }),
  });
  const [review, setReview] = useState<(typeof REVIEW_OUTCOMES)[number]>('approve');
  const setKycReview = useRepoMutation('demo', 'setKycReview', {
    invalidates: [],
    onError,
    onSuccess: (_, { body }) => {
      setReview(body.outcome);
      toast.show({
        message: t(`demo.scenarios.review.${body.outcome}.toast`),
        tone: 'info',
      });
    },
  });
  const failNext = useRepoMutation('demo', 'failNextTransfer', {
    invalidates: [],
    onError,
    onSuccess: () =>
      toast.show({
        message: t('demo.scenarios.failNextDone'),
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
      message: t('demo.scenarios.now', { date: dateFormat.format(new Date(result.now)) }),
      tone: 'success',
    });
  };

  return (
    <DemoSection title={t('demo.scenarios.title')} description={t('demo.scenarios.description')}>
      <Button
        label={t('demo.scenarios.failNext')}
        icon={OctagonX}
        variant="secondary"
        loading={failNext.isPending}
        onPress={() => failNext.mutate(undefined)}
      />
      <View style={{ gap: spacing[3] }}>
        <ChipRow label={t('demo.scenarios.timeTravel')}>
          {TIME_TRAVEL_DAYS.map((d) => (
            <Chip
              key={d}
              label={t('demo.scenarios.days', { count: d })}
              selected={d === days}
              onPress={() => setDays(d)}
            />
          ))}
        </ChipRow>
        {projected && projected.amount > 0n && (
          <Text variant="bodySmall" color="textMuted">
            {t('demo.scenarios.wouldEarn', { amount: formatMoney(projected) })}
          </Text>
        )}
        {clock && (
          <View style={{ gap: spacing[1] }} accessibilityLiveRegion="polite">
            <Text variant="bodySmall" color="textMuted">
              {t('demo.scenarios.demoDate', {
                date: dateFormat.format(new Date(clock.now)),
                count: clock.offset_days,
              })}
            </Text>
            {outcome && <Text variant="bodySmall">{outcome}</Text>}
          </View>
        )}
        <Button
          label={t('demo.scenarios.jump', { count: days })}
          icon={CalendarClock}
          variant="secondary"
          loading={travel.isPending}
          onPress={() => void jump().catch(() => undefined)}
        />
      </View>
      <View style={{ gap: spacing[2] }}>
        <ChipRow label={t('demo.scenarios.tier')}>
          {([1, 2, 3] as const).map((tier) => (
            <Chip
              key={tier}
              label={t('demo.scenarios.tierN', { tier })}
              selected={me.data?.kyc_tier === tier}
              disabled={setTier.isPending}
              onPress={() => setTier.mutate({ body: { tier } })}
            />
          ))}
        </ChipRow>
        <Text variant="bodySmall" color="textMuted">
          {t('demo.scenarios.tierHelp')}
        </Text>
      </View>
      <View style={{ gap: spacing[2] }}>
        <ChipRow label={t('demo.scenarios.nextReview')}>
          {REVIEW_OUTCOMES.map((outcome) => (
            <Chip
              key={outcome}
              label={t(`demo.scenarios.review.${outcome}.label`)}
              selected={review === outcome}
              disabled={setKycReview.isPending}
              onPress={() => setKycReview.mutate({ body: { outcome } })}
            />
          ))}
        </ChipRow>
        <Text variant="bodySmall" color="textMuted">
          {t('demo.scenarios.reviewHelp')}
        </Text>
      </View>
      <Button
        label={t('demo.scenarios.endSession')}
        icon={LogOut}
        variant="ghost"
        accessibilityHint={t('demo.scenarios.endSessionHint')}
        onPress={() => useSessionStore.getState().expire()}
      />
    </DemoSection>
  );
}
