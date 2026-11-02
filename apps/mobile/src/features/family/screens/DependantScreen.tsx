import type { Schema } from '@nem/contracts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CalendarClock, Inbox, ListChecks, Smile } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import {
  Avatar,
  Badge,
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  ErrorState,
  MoneyText,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Switch,
  Text,
  useToast,
} from '@/components';
import { isApiError } from '@/data';
import i18n from '@/lib/i18n';
import { formatDateTime } from '@/features/transactions/format';
import { TransactionRow } from '@/features/transactions/TransactionRow';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { fromApiMoney, toApiMoney } from '@/lib/money';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import {
  ageOn,
  ALLOWANCE_PRESETS,
  allowanceSummary,
  APPROVAL_PRESETS,
  DAILY_LIMIT_PRESETS,
  MONTH_DAYS,
  nairaText,
  weekdays,
  type Controls,
} from '../family';

const message = (e: unknown) =>
  isApiError(e) ? (e.problem.detail ?? e.problem.title) : i18n.t('common.somethingWrong');

type Frequency = Schema<'Allowance'>['frequency'];

/**
 * One child (FAM-2, FAM-3): their limits and pause switch, the allowance you
 * send them, and everything they've spent or received.
 */
export function DependantScreen() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const path = { dependant_id: id };
  const q = useRepoQuery('family', 'getDependant', { path });
  const activity = useRepoQuery('family', 'listActivity', { path, query: { limit: 20 } });
  const accounts = useRepoQuery('accounts', 'list');
  const update = useRepoMutation('family', 'updateControls', {
    onError: (e) => toast.show({ message: message(e), tone: 'error' }),
  });
  const setAllowance = useRepoMutation('family', 'setAllowance', {
    onSuccess: () => toast.show({ message: t('family.child.allowanceSet'), tone: 'success' }),
  });
  const stopAllowance = useRepoMutation('family', 'stopAllowance', {
    onSuccess: () => toast.show({ message: t('family.child.allowanceStopped'), tone: 'success' }),
  });

  const [amount, setAmount] = useState(toApiMoney(ALLOWANCE_PRESETS[1]!));
  const [frequency, setFrequency] = useState<Frequency>('weekly');
  const [day, setDay] = useState(5);

  const header = <SendHeader title={q.data?.profile.name ?? t('family.child.title')} />;
  if (!q.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {q.isError ? (
          <ErrorState title={t('family.child.failed')} onRetry={() => q.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel={t('common.loading')}>
            <Skeleton height={120} />
            <Skeleton height={220} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const child = q.data;
  const first = child.profile.name.split(' ')[0];
  const controls = child.controls;
  const save = (next: Partial<Controls>) =>
    update.mutate({ path, body: { controls: { ...controls, ...next } } });
  const source = accounts.data?.data.find((a) => a.currency === 'NGN');

  const presets = (
    label: string,
    options: typeof DAILY_LIMIT_PRESETS,
    key: 'daily_spend_limit' | 'approval_threshold',
  ) => (
    <View style={{ gap: spacing[2] }}>
      <Text variant="label" color="textMuted">
        {label}
      </Text>
      <View style={[styles.wrap, { gap: spacing[2] }]}>
        {options.map((m) => {
          const value = toApiMoney(m);
          return (
            <Chip
              key={value.amount_minor}
              label={nairaText(value)}
              selected={controls[key].amount_minor === value.amount_minor}
              disabled={update.isPending}
              onPress={() => save({ [key]: value })}
            />
          );
        })}
      </View>
    </View>
  );

  const startAllowance = () => {
    if (!source) return;
    setAllowance.mutate({
      path,
      body: { amount, frequency, day, source_account_id: source.id },
    });
  };

  return (
    <Screen
      header={header}
      edges={['top', 'bottom']}
      onRefresh={() => void Promise.all([q.refetch(), activity.refetch()])}
      refreshing={q.isRefetching}
    >
      <Card>
        <View style={[styles.row, { gap: spacing[3] }]}>
          <Avatar name={child.profile.name} size="lg" />
          <View style={[styles.flex, { gap: spacing[1] }]}>
            <Text variant="bodyStrong">{child.profile.name}</Text>
            <Text variant="bodySmall" color="textMuted">
              {[
                child.profile.nemtag && `@${child.profile.nemtag}`,
                t('common.yearsOld', { count: ageOn(child.date_of_birth, new Date()) }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            {child.kid_mode && <Badge label={t('common.kidMode')} tone="primary" />}
          </View>
          <MoneyText value={fromApiMoney(child.balance)} variant="h3" trimZeroMinor />
        </View>
      </Card>
      <Button
        label={t('family.approvals.title')}
        icon={ListChecks}
        variant="secondary"
        fullWidth
        onPress={() => router.push('/family/approvals')}
      />
      {child.kid_mode && (
        <Button
          label={t('family.child.seeKid', { name: first })}
          icon={Smile}
          variant="secondary"
          fullWidth
          onPress={() => router.push({ pathname: '/family/[id]/kid', params: { id } })}
        />
      )}

      <SectionHeader title={t('family.child.limits')} />
      <Card>
        <View style={{ gap: spacing[4] }}>
          {presets(t('family.child.dailyLimit'), DAILY_LIMIT_PRESETS, 'daily_spend_limit')}
          {presets(t('family.child.askBefore'), APPROVAL_PRESETS, 'approval_threshold')}
          <Divider />
          <Switch
            label={t('family.child.banks')}
            description={t('family.child.banksHelp', { name: first })}
            value={controls.can_send_to_banks}
            disabled={update.isPending}
            onValueChange={(v) => save({ can_send_to_banks: v })}
          />
          <Switch
            label={t('family.child.pause')}
            description={t('family.child.pauseHelp', { name: first })}
            value={controls.paused}
            disabled={update.isPending}
            onValueChange={(v) => save({ paused: v })}
          />
          <Switch
            label={t('common.kidMode')}
            description={t('family.child.kidModeHelp')}
            value={child.kid_mode}
            disabled={update.isPending}
            onValueChange={(v) => update.mutate({ path, body: { kid_mode: v } })}
          />
        </View>
      </Card>

      <SectionHeader title={t('family.child.allowance')} />
      <Card>
        {child.allowance ? (
          <View style={{ gap: spacing[3] }}>
            <Text variant="bodyStrong">{allowanceSummary(child.allowance)}</Text>
            {child.allowance.next_run_at && (
              <Text variant="bodySmall" color="textMuted">
                {t('family.child.nextOn', { when: formatDateTime(child.allowance.next_run_at) })}
              </Text>
            )}
            <Button
              label={t('family.child.stop')}
              variant="secondary"
              loading={stopAllowance.isPending}
              onPress={() => stopAllowance.mutate({ path })}
            />
          </View>
        ) : (
          <View style={{ gap: spacing[3] }}>
            <Text variant="bodySmall" color="textMuted">
              {t('family.child.allowanceIntro', { name: first })}
            </Text>
            <View style={[styles.wrap, { gap: spacing[2] }]}>
              {ALLOWANCE_PRESETS.map((m) => {
                const value = toApiMoney(m);
                return (
                  <Chip
                    key={value.amount_minor}
                    label={nairaText(value)}
                    selected={amount.amount_minor === value.amount_minor}
                    onPress={() => setAmount(value)}
                  />
                );
              })}
            </View>
            <View style={[styles.wrap, { gap: spacing[2] }]}>
              {(['weekly', 'monthly'] as const).map((f) => (
                <Chip
                  key={f}
                  label={t(f === 'weekly' ? 'common.weekly' : 'common.monthly')}
                  selected={frequency === f}
                  onPress={() => {
                    setFrequency(f);
                    setDay(f === 'weekly' ? 5 : 1);
                  }}
                />
              ))}
            </View>
            <View style={[styles.wrap, { gap: spacing[2] }]}>
              {frequency === 'weekly'
                ? weekdays().map((name, i) => (
                    <Chip
                      key={name}
                      label={name.slice(0, 3)}
                      selected={day === i + 1}
                      onPress={() => setDay(i + 1)}
                    />
                  ))
                : MONTH_DAYS.map((d) => (
                    <Chip
                      key={d}
                      label={t('family.child.day', { day: d })}
                      selected={day === d}
                      onPress={() => setDay(d)}
                    />
                  ))}
            </View>
            {setAllowance.error && (
              <Text variant="bodySmall" color="danger">
                {message(setAllowance.error)}
              </Text>
            )}
            <Button
              label={t('family.child.setAllowance')}
              icon={CalendarClock}
              loading={setAllowance.isPending}
              disabled={!source}
              onPress={startAllowance}
            />
          </View>
        )}
      </Card>

      <SectionHeader title={t('family.child.activity')} />
      {activity.isError ? (
        <ErrorState title={t('family.child.activityFailed')} onRetry={() => activity.refetch()} />
      ) : !activity.data ? (
        <Skeleton height={160} />
      ) : activity.data.data.length ? (
        <Card>
          {activity.data.data.map((tx) => (
            <TransactionRow key={tx.id} transaction={tx} />
          ))}
        </Card>
      ) : (
        <EmptyState
          icon={Inbox}
          title={t('family.child.nothing')}
          message={t('family.child.nothingMessage', { name: first })}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap' },
});
