import type { Schema } from '@nem/contracts';
import { addDaysIso, formatMoney, lagosToday } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Minus, Plus } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { AmountInput, Button, Card, Chip, IconButton, Screen, Text, TextField } from '@/components';
import { formatGoalDate } from '@/features/savings/goals';
import { typedNaira } from '@/features/transfers/amount';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import i18n, { withLabel } from '@/lib/i18n';
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

const STARTS = ([1, 7, 14] as const).map((days) => withLabel(`ajo.new.starts.${days}`, { days }));
/** Words are read in the current language on access. */
const ROTATIONS = (['fixed', 'random_draw'] as const satisfies Rotation[]).map((value) => ({
  value,
  get label() {
    return i18n.t(`ajo.new.rotations.${value}.label`);
  },
  get help() {
    return i18n.t(`ajo.new.rotations.${value}.help`);
  },
}));

/**
 * Start an ajo (AJO-1): a name, how much each person pays and how often, how
 * many people, the payout order and when it starts. Nothing is paid until the
 * organiser starts it with everyone in.
 */
export function NewAjoScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [typed, setTyped] = useState('');
  const [frequency, setFrequency] = useState<Schema<'AjoFrequency'>>('weekly');
  const [members, setMembers] = useState(5);
  const [rotation, setRotation] = useState<Rotation>('fixed');
  const [startIn, setStartIn] = useState<number>(STARTS[0]!.days);
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
        onError: () => setError(t('ajo.new.failed')),
      },
    );
  };

  return (
    <Screen
      header={<SendHeader title={t('ajo.list.start')} />}
      edges={['top', 'bottom']}
      footer={
        <Button
          label={t('ajo.new.create')}
          disabled={!ready}
          loading={create.isPending}
          onPress={onCreate}
        />
      }
    >
      <TextField
        label={t('ajo.new.name')}
        placeholder={t('ajo.new.namePlaceholder')}
        value={name}
        onChangeText={setName}
        maxLength={MAX_AJO_NAME}
        autoCapitalize="words"
      />

      <AmountInput
        currency="NGN"
        label={t('ajo.details.eachPays')}
        value={typed}
        onChangeValue={setTyped}
        maxWholeDigits={8}
      />

      <View style={{ gap: spacing[2] }}>
        <Text variant="label">{t('ajo.new.howOften')}</Text>
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
          <Text variant="label">{t('ajo.new.people')}</Text>
          <Text variant="caption" color="textMuted">
            {t('ajo.new.between', { min: MIN_MEMBERS, max: MAX_MEMBERS })}
          </Text>
        </View>
        <IconButton
          icon={Minus}
          variant="secondary"
          accessibilityLabel={t('ajo.new.fewer')}
          disabled={members <= MIN_MEMBERS}
          onPress={() => setMembers((n) => n - 1)}
        />
        <Text variant="title" accessibilityLabel={t('ajo.new.count', { count: members })}>
          {members}
        </Text>
        <IconButton
          icon={Plus}
          variant="secondary"
          accessibilityLabel={t('ajo.new.more')}
          disabled={members >= MAX_MEMBERS}
          onPress={() => setMembers((n) => n + 1)}
        />
      </View>

      <View style={{ gap: spacing[2] }}>
        <Text variant="label">{t('ajo.details.payoutOrder')}</Text>
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
        <Text variant="label">{t('ajo.details.firstPayment')}</Text>
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
              {t('ajo.new.summary', {
                contribution: contributionLabel(amount, frequency),
                pot: formatMoney(potOf(amount, members), { trimZeroMinor: true }),
              })}
            </Text>
            <Text variant="bodySmall" color="textMuted">
              {t('ajo.new.runs', {
                duration: durationLabel(members, frequency),
                date: formatGoalDate(startDate),
                count: members,
              })}
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
