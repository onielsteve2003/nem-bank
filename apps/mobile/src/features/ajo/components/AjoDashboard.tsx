import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { ShieldAlert } from 'lucide-react-native';
import { View } from 'react-native';

import {
  Avatar,
  Badge,
  Card,
  ErrorState,
  Icon,
  ListItem,
  MoneyText,
  SectionHeader,
  Skeleton,
  Text,
} from '@/components';
import { DetailRow } from '@/features/savings/components/DetailRow';
import { formatGoalDate } from '@/features/savings/goals';
import { fromApiMoney } from '@/lib/money';
import { useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { CONTRIBUTION_STATUS, PAYOUT_STATUS, paidCount } from '../ajo';

type Group = Schema<'AjoGroup'>;

const dateOf = (iso: string) => formatGoalDate(iso.slice(0, 10));
const amountOf = (m: Schema<'Money'>) => formatMoney(fromApiMoney(m), { trimZeroMinor: true });

/**
 * A running or finished ajo (AJO-3, AJO-4, AJO-5): what is in the pot, who
 * takes it next, who has paid this turn, every turn past and to come, and the
 * rules for a member who misses a payment.
 */
export function AjoDashboard({ group: g, meId }: { group: Group; meId?: string }) {
  const { spacing } = useTheme();
  const cycles = useRepoQuery('ajo', 'listCycles', { path: { group_id: g.id } });
  const current = cycles.data?.data.find((c) => c.number === g.current_cycle);
  const next = g.next_payout;

  return (
    <>
      <Card>
        <View style={{ gap: spacing[3] }}>
          <View style={{ gap: spacing[1] }}>
            <Text variant="caption" color="textMuted">
              In the pot
            </Text>
            <MoneyText value={fromApiMoney(g.pot_balance)} label="In the pot" />
          </View>
          <Text variant="body">
            {next
              ? next.member.user_id === meId
                ? `Your ${amountOf(next.amount)} payout is due ${dateOf(next.at)}.`
                : `${next.member.name} gets ${amountOf(next.amount)} on ${dateOf(next.at)}.`
              : g.status === 'completed'
                ? `Everyone has had their turn. ${g.name} is complete.`
                : 'No payout is due.'}
          </Text>
          <Text variant="caption" color="textMuted">
            Contributions are taken from each member automatically on the due date and held by Nem
            until the payout, which only ever goes to the member whose turn it is.
          </Text>
        </View>
      </Card>

      {cycles.isError ? (
        <ErrorState title="We couldn't load the schedule" onRetry={() => cycles.refetch()} />
      ) : !cycles.data ? (
        <Skeleton height={240} />
      ) : (
        <>
          {current && (
            <View style={{ gap: spacing[2] }}>
              <SectionHeader
                title={`Turn ${current.number} · ${paidCount(current)} of ${current.contributions.length} paid`}
              />
              <Card padded={false}>
                {current.contributions.map((c) => {
                  const s = CONTRIBUTION_STATUS[c.status];
                  return (
                    <ListItem
                      key={c.member.user_id}
                      leading={<Avatar name={c.member.name} size="sm" />}
                      title={c.member.user_id === meId ? `${c.member.name} (you)` : c.member.name}
                      subtitle={
                        c.paid_at
                          ? `Paid ${dateOf(c.paid_at)}`
                          : c.attempts > 0
                            ? `${c.attempts} attempt${c.attempts === 1 ? '' : 's'} so far`
                            : `Due ${dateOf(current.due_at)}`
                      }
                      trailing={<Badge label={s.label} tone={s.tone} />}
                    />
                  );
                })}
              </Card>
            </View>
          )}

          <View style={{ gap: spacing[2] }}>
            <SectionHeader title="Schedule and history" />
            <Card padded={false}>
              {cycles.data.data.map((c) => {
                const s = PAYOUT_STATUS[c.payout_status];
                const missed = c.contributions.filter((x) => x.status === 'defaulted').length;
                const done = c.payout_status === 'paid' || c.payout_status === 'short_paid';
                const who = c.payout_to.user_id === meId ? 'You' : c.payout_to.name;
                return (
                  <ListItem
                    key={c.number}
                    leading={<Avatar name={c.payout_to.name} size="sm" />}
                    title={`Turn ${c.number} · ${who}`}
                    subtitle={[
                      `${amountOf(c.payout_amount)} ${done ? 'paid' : 'due'} ${dateOf(c.due_at)}`,
                      missed > 0 ? `${missed} defaulted` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                    trailing={<Badge label={s.label} tone={s.tone} />}
                  />
                );
              })}
            </Card>
          </View>
        </>
      )}

      <View style={{ gap: spacing[2] }}>
        <SectionHeader title="If someone misses a payment" />
        <Card>
          <View style={{ gap: spacing[3] }}>
            <View style={{ flexDirection: 'row', gap: spacing[2], alignItems: 'center' }}>
              <Icon icon={ShieldAlert} color="warning" />
              <Text variant="bodyStrong">The pot is protected by the ledger</Text>
            </View>
            <DetailRow label="Retries" value="On the due date and when grace ends" />
            <DetailRow label="Grace period" value={`${g.grace_period_hours} hours`} />
            <Text variant="caption" color="textMuted">
              A member still unpaid after the grace period is flagged as a defaulter, and everyone
              in the ajo sees it. Late money that arrives goes straight to that turn&apos;s payee.
            </Text>
            <Text variant="caption" color="textMuted">
              A defaulter who has already had their payout owes the ajo: they can&apos;t start or
              join another ajo on Nem until they have paid what they missed.
            </Text>
          </View>
        </Card>
      </View>
    </>
  );
}
