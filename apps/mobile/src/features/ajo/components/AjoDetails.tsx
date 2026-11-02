import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Avatar, Badge, Card, ListItem, SectionHeader } from '@/components';
import { DetailRow } from '@/features/savings/components/DetailRow';
import { formatGoalDate } from '@/features/savings/goals';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { contributionLabel, defaultFlag, durationLabel, joinedCount, potOf } from '../ajo';

type Group = Schema<'AjoGroup'>;

/** An ajo's terms and its members in payout order, as both members and invitees see it. */
export function AjoDetails({ group: g, meId }: { group: Group; meId?: string }) {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const contribution = fromApiMoney(g.contribution);
  const members = [...g.members]
    .filter((m) => m.status !== 'left')
    .sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
  const open = g.member_count - joinedCount(g);

  return (
    <>
      <Card>
        <View style={{ gap: spacing[3] }}>
          <DetailRow
            label={t('ajo.details.eachPays')}
            value={contributionLabel(contribution, g.frequency)}
          />
          <DetailRow
            label={t('ajo.details.eachPayout')}
            value={formatMoney(potOf(contribution, g.member_count), { trimZeroMinor: true })}
          />
          <DetailRow label={t('ajo.details.people')} value={String(g.member_count)} />
          <DetailRow
            label={t('ajo.details.runsFor')}
            value={durationLabel(g.member_count, g.frequency)}
          />
          <DetailRow
            label={t('ajo.details.payoutOrder')}
            value={t(
              g.rotation === 'fixed' ? 'ajo.details.orderJoined' : 'ajo.details.orderRandom',
            )}
          />
          {g.next_contribution_at && (
            <DetailRow
              label={t(
                g.status === 'forming' ? 'ajo.details.firstPayment' : 'ajo.details.nextPayment',
              )}
              value={formatGoalDate(g.next_contribution_at.slice(0, 10))}
            />
          )}
          <DetailRow label={t('ajo.details.organiser')} value={g.created_by.name} />
        </View>
      </Card>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader
          title={
            g.status === 'forming'
              ? t('ajo.details.placesLeft', { count: open })
              : t('ajo.details.payoutOrder')
          }
        />
        <Card padded={false}>
          {members.map((m) => {
            const isMe = m.member.user_id === meId;
            const turn = m.position
              ? t('ajo.details.turn', { turn: m.position })
              : t('ajo.details.turnDrawn');
            const flag = defaultFlag(m);
            return (
              <ListItem
                key={m.member.user_id}
                leading={<Avatar name={m.member.name} size="sm" />}
                title={isMe ? t('common.nameYou', { name: m.member.name }) : m.member.name}
                subtitle={m.member.nemtag ? `@${m.member.nemtag} · ${turn}` : turn}
                trailing={
                  flag ? (
                    <Badge label={flag.label} tone={flag.tone} />
                  ) : m.has_received_payout ? (
                    <Badge label={t('ajo.payout.paid')} tone="success" />
                  ) : m.member.user_id === g.created_by.user_id ? (
                    <Badge label={t('ajo.details.organiser')} tone="neutral" />
                  ) : undefined
                }
              />
            );
          })}
        </Card>
      </View>
    </>
  );
}
