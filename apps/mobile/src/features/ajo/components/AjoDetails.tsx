import type { Schema } from '@nem/contracts';
import { formatMoney } from '@nem/shared';
import { View } from 'react-native';

import { Avatar, Badge, Card, ListItem, SectionHeader } from '@/components';
import { DetailRow } from '@/features/savings/components/DetailRow';
import { formatGoalDate } from '@/features/savings/goals';
import { fromApiMoney } from '@/lib/money';
import { useTheme } from '@/theme';

import { contributionLabel, durationLabel, joinedCount, potOf } from '../ajo';

type Group = Schema<'AjoGroup'>;

/** An ajo's terms and its members in payout order, as both members and invitees see it. */
export function AjoDetails({ group: g, meId }: { group: Group; meId?: string }) {
  const { spacing } = useTheme();
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
            label="Each person pays"
            value={contributionLabel(contribution, g.frequency)}
          />
          <DetailRow
            label="Each payout"
            value={formatMoney(potOf(contribution, g.member_count), { trimZeroMinor: true })}
          />
          <DetailRow label="People" value={String(g.member_count)} />
          <DetailRow label="Runs for" value={durationLabel(g.member_count, g.frequency)} />
          <DetailRow
            label="Payout order"
            value={g.rotation === 'fixed' ? 'Order people joined' : 'Random draw at start'}
          />
          {g.next_contribution_at && (
            <DetailRow
              label={g.status === 'forming' ? 'First payment' : 'Next payment'}
              value={formatGoalDate(g.next_contribution_at.slice(0, 10))}
            />
          )}
          <DetailRow label="Organiser" value={g.created_by.name} />
        </View>
      </Card>

      <View style={{ gap: spacing[2] }}>
        <SectionHeader
          title={
            g.status === 'forming'
              ? `Members · ${open} place${open === 1 ? '' : 's'} left`
              : 'Payout order'
          }
        />
        <Card padded={false}>
          {members.map((m) => {
            const isMe = m.member.user_id === meId;
            const turn = m.position ? `Turn ${m.position}` : 'Turn drawn at start';
            return (
              <ListItem
                key={m.member.user_id}
                leading={<Avatar name={m.member.name} size="sm" />}
                title={isMe ? `${m.member.name} (you)` : m.member.name}
                subtitle={m.member.nemtag ? `@${m.member.nemtag} · ${turn}` : turn}
                trailing={
                  m.has_received_payout ? (
                    <Badge label="Paid out" tone="success" />
                  ) : m.member.user_id === g.created_by.user_id ? (
                    <Badge label="Organiser" tone="neutral" />
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
