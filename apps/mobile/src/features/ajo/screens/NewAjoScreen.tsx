import type { Schema } from '@nem/contracts';
import { addDaysIso, formatMoney, lagosToday } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Minus, Plus } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AmountInput, Button, Card, Chip, IconButton, Screen, Text, TextField } from '@/components';
import { formatGoalDate } from '@/features/savings/goals';
import { typedNaira } from '@/features/transfers/amount';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { toApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import {
  contributionLabel,
  durationLabel,
  FREQUENCIES,
  MAX_AJO_NAME,
  MAX_MEMBERS,
  MIN_MEMBERS,
  potOf,
} from '../ajo';

type Rotation = Schema<'CreateAjoGroupRequest'>['rotation'];

const STARTS = [
  { days: 1, label: 'Tomorrow' },
  { days: 7, label: 'In a week' },
  { days: 14, label: 'In 2 weeks' },
];
const ROTATIONS: { value: Rotation; label: string; help: string }[] = [
  {
    value: 'fixed',
    label: 'In the order people join',
    help: 'You go first, then each person who joins.',
  },
  {
    value: 'random_draw',
    label: 'Random draw',
    help: 'Nem draws the order when you start, so nobody picks their turn.',
  },
];

/**
 * Start an ajo (AJO-1): a name, how much each person pays and how often, how
 * many people, the payout order and when it starts. Nothing is paid until the
 * organiser starts it with everyone in.
 */
export function NewAjoScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const [name, setName] = useState('');
  const [typed, setTyped] = useState('');
  const [frequency, setFrequency] = useState<Schema<'AjoFrequency'>>('weekly');
  const [members, setMembers] = useState(5);
  const [rotation, setRotation] = useState<Rotation>('fixed');
  const [startIn, setStartIn] = useState(STARTS[0]!.days);
  const [error, setError] = useState<string>();
  const accounts = useRepoQuery('accounts', 'list');
  const naira = accounts.data?.data.find((a) => a.currency === 'NGN');
  const create = useMoneyMutation('ajo', 'createGroup', { invalidates: [['ajo']] });

  const amount = typedNaira(typed);
  const startDate = addDaysIso(lagosToday(), startIn);
  const ready = Boolean(name.trim() && amount && naira);

  const onCreate = () => {
    if (!amount || !naira) return;
    setError(undefined);
    create.mutate(
      {
        body: {
          name: name.trim(),
          contribution: toApiMoney(amount),
          frequency,
          member_count: members,
          rotation,
          start_date: startDate,
          grace_period_hours: 24,
          source_account_id: naira.id,
        },
      },
      {
        onSuccess: (g) => router.replace({ pathname: '/ajo/group/[id]', params: { id: g.id } }),
        onError: () => setError("We couldn't create the ajo. Try again."),
      },
    );
  };

  return (
    <Screen
      header={<SendHeader title="Start an ajo" />}
      edges={['top', 'bottom']}
      footer={
        <Button
          label="Create ajo"
          disabled={!ready}
          loading={create.isPending}
          onPress={onCreate}
        />
      }
    >
      <TextField
        label="Name"
        placeholder="Lekki Girls Ajo"
        value={name}
        onChangeText={setName}
        maxLength={MAX_AJO_NAME}
        autoCapitalize="words"
      />

      <AmountInput
        currency="NGN"
        label="Each person pays"
        value={typed}
        onChangeValue={setTyped}
        maxWholeDigits={8}
      />

      <View style={{ gap: spacing[2] }}>
        <Text variant="label">How often</Text>
        <View accessibilityRole="radiogroup" style={[styles.row, { gap: spacing[2] }]}>
          {FREQUENCIES.map((f) => (
            <Chip
              key={f.value}
              label={f.label}
              selected={frequency === f.value}
              onPress={() => setFrequency(f.value)}
            />
          ))}
        </View>
      </View>

      <View style={[styles.between, { gap: spacing[3] }]}>
        <View style={styles.flex}>
          <Text variant="label">People, including you</Text>
          <Text variant="caption" color="textMuted">
            Between {MIN_MEMBERS} and {MAX_MEMBERS}
          </Text>
        </View>
        <IconButton
          icon={Minus}
          variant="secondary"
          accessibilityLabel="One person fewer"
          disabled={members <= MIN_MEMBERS}
          onPress={() => setMembers((n) => n - 1)}
        />
        <Text variant="title" accessibilityLabel={`${members} people`}>
          {members}
        </Text>
        <IconButton
          icon={Plus}
          variant="secondary"
          accessibilityLabel="One more person"
          disabled={members >= MAX_MEMBERS}
          onPress={() => setMembers((n) => n + 1)}
        />
      </View>

      <View style={{ gap: spacing[2] }}>
        <Text variant="label">Payout order</Text>
        <View accessibilityRole="radiogroup" style={[styles.row, { gap: spacing[2] }]}>
          {ROTATIONS.map((r) => (
            <Chip
              key={r.value}
              label={r.label}
              selected={rotation === r.value}
              onPress={() => setRotation(r.value)}
            />
          ))}
        </View>
        <Text variant="caption" color="textMuted">
          {ROTATIONS.find((r) => r.value === rotation)!.help}
        </Text>
      </View>

      <View style={{ gap: spacing[2] }}>
        <Text variant="label">First payment</Text>
        <View accessibilityRole="radiogroup" style={[styles.row, { gap: spacing[2] }]}>
          {STARTS.map((s) => (
            <Chip
              key={s.days}
              label={s.label}
              selected={startIn === s.days}
              onPress={() => setStartIn(s.days)}
            />
          ))}
        </View>
      </View>

      {amount && (
        <Card>
          <View style={{ gap: spacing[2] }}>
            <Text variant="bodyStrong">
              Everyone pays {contributionLabel(amount, frequency)}; each turn pays out{' '}
              {formatMoney(potOf(amount, members), { trimZeroMinor: true })}.
            </Text>
            <Text variant="bodySmall" color="textMuted">
              Runs for {durationLabel(members, frequency)} from {formatGoalDate(startDate)}, once
              all {members} people are in. Payments come from your naira account.
            </Text>
          </View>
        </Card>
      )}

      {error && (
        <Text variant="bodySmall" color="danger" accessibilityRole="alert">
          {error}
        </Text>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap' },
  between: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
