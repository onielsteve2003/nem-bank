import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { ShieldAlert } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const cycles = useRepoQuery('ajo', 'listCycles', { path: { group_id: g.id } });
  const current = cycles.data?.data.find((c) => c.number === g.current_cycle);
  const next = g.next_payout;

  return (
    <>
      <Card>
        <View style={{ gap: spacing[3] }}>
          <View style={{ gap: spacing[1] }}>
            <Text variant="caption" color="textMuted">
              {t('ajo.dashboard.inPot')}
            </Text>
            <MoneyText value={fromApiMoney(g.pot_balance)} label={t('ajo.dashboard.inPot')} />
          </View>
          <Text variant="body">
            {next
              ? next.member.user_id === meId
                ? t('ajo.dashboard.yourPayout', {
                    amount: amountOf(next.amount),
                    date: dateOf(next.at),
                  })
                : t('ajo.dashboard.theirPayout', {
                    name: next.member.name,
                    amount: amountOf(next.amount),
                    date: dateOf(next.at),
                  })
              : g.status === 'completed'
                ? t('ajo.dashboard.complete', { name: g.name })
                : t('ajo.dashboard.noPayout')}
          </Text>
          <Text variant="caption" color="textMuted">
            {t('ajo.dashboard.held')}
          </Text>
        </View>
      </Card>

      {cycles.isError ? (
        <ErrorState title={t('ajo.dashboard.scheduleFailed')} onRetry={() => cycles.refetch()} />
      ) : !cycles.data ? (
        <Skeleton height={240} />
      ) : (
        <>
          {current && (
            <View style={{ gap: spacing[2] }}>
              <SectionHeader
                title={t('ajo.dashboard.turnPaid', {
                  turn: current.number,
                  paid: paidCount(current),
                  total: current.contributions.length,
                })}
              />
              <Card padded={false}>
                {current.contributions.map((c) => {
                  const s = CONTRIBUTION_STATUS[c.status];
                  return (
                    <ListItem
                      key={c.member.user_id}
                      leading={<Avatar name={c.member.name} size="sm" />}
                      title={
                        c.member.user_id === meId
                          ? t('common.nameYou', { name: c.member.name })
                          : c.member.name
                      }
                      subtitle={
                        c.paid_at
                          ? t('ajo.dashboard.paidOn', { date: dateOf(c.paid_at) })
                          : c.attempts > 0
                            ? t('ajo.dashboard.attempts', { count: c.attempts })
                            : t('ajo.dashboard.dueOn', { date: dateOf(current.due_at) })
                      }
                      trailing={<Badge label={s.label} tone={s.tone} />}
                    />
                  );
                })}
              </Card>
            </View>
          )}

          <View style={{ gap: spacing[2] }}>
            <SectionHeader title={t('ajo.dashboard.schedule')} />
            <Card padded={false}>
              {cycles.data.data.map((c) => {
                const s = PAYOUT_STATUS[c.payout_status];
                const missed = c.contributions.filter((x) => x.status === 'defaulted').length;
                const done = c.payout_status === 'paid' || c.payout_status === 'short_paid';
                const who = c.payout_to.user_id === meId ? t('common.you') : c.payout_to.name;
                return (
                  <ListItem
                    key={c.number}
                    leading={<Avatar name={c.payout_to.name} size="sm" />}
                    title={t('ajo.dashboard.turnWho', { turn: c.number, who })}
                    subtitle={[
                      t(done ? 'ajo.dashboard.paidLine' : 'ajo.dashboard.dueLine', {
                        amount: amountOf(c.payout_amount),
                        date: dateOf(c.due_at),
                      }),
                      missed > 0 ? t('ajo.dashboard.defaulted', { count: missed }) : null,
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
        <SectionHeader title={t('ajo.dashboard.missesTitle')} />
        <Card>
          <View style={{ gap: spacing[3] }}>
            <View style={{ flexDirection: 'row', gap: spacing[2], alignItems: 'center' }}>
              <Icon icon={ShieldAlert} color="warning" />
              <Text variant="bodyStrong">{t('ajo.dashboard.protected')}</Text>
            </View>
            <DetailRow label={t('ajo.dashboard.retries')} value={t('ajo.dashboard.retriesValue')} />
            <DetailRow
              label={t('ajo.dashboard.grace')}
              value={t('ajo.dashboard.graceValue', { hours: g.grace_period_hours })}
            />
            <Text variant="caption" color="textMuted">
              {t('ajo.dashboard.defaulterRule')}
            </Text>
            <Text variant="caption" color="textMuted">
              {t('ajo.dashboard.owesRule')}
            </Text>
          </View>
        </Card>
      </View>
    </>
  );
}
