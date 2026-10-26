import { formatMoney } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Users } from 'lucide-react-native';
import { useState } from 'react';
import { View } from 'react-native';

import { Button, Checkbox, EmptyState, Screen, Skeleton, SkeletonGroup, Text } from '@/components';
import { isApiError } from '@/data/errors';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { sendErrorMessage } from '@/features/transfers/confirm';
import { fromApiMoney } from '@/lib/money';
import { useMoneyMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { contributionLabel, joinedCount } from '../ajo';
import { AjoDetails } from '../components/AjoDetails';

/**
 * An ajo invite opened from a link or code (AJO-2): who is organising it, the
 * terms and who is in, then join with the PIN or Face ID. Joining agrees to
 * pay every cycle from naira once the organiser starts it.
 */
export function AjoInviteScreen({ code }: { code: string }) {
  const router = useRouter();
  const { spacing } = useTheme();
  const invite = useRepoQuery('ajo', 'getInvite', { path: { invite_code: code } });
  const me = useRepoQuery('users', 'getMe');
  const accounts = useRepoQuery('accounts', 'list');
  const naira = accounts.data?.data.find((a) => a.currency === 'NGN');
  const [agreed, setAgreed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const accept = useMoneyMutation('ajo', 'acceptInvite', { invalidates: [['ajo']] });

  const openGroup = (id: string) => router.replace({ pathname: '/ajo/group/[id]', params: { id } });

  const run = async () => {
    if (!naira) return false;
    setError(undefined);
    try {
      const g = await accept.mutateAsync({
        path: { invite_code: code },
        body: { source_account_id: naira.id },
      });
      setConfirming(false);
      openGroup(g.id);
      return true;
    } catch (e) {
      setError(sendErrorMessage(e as Error).message);
      return false;
    }
  };

  const header = <SendHeader title="Ajo invite" first />;
  if (invite.isError) {
    const notFound = isApiError(invite.error) && invite.error.problem.status === 404;
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <EmptyState
          icon={Users}
          title={notFound ? 'This invite link is not valid' : "We couldn't open this invite"}
          message={
            notFound
              ? 'Check the link or code with the person who sent it.'
              : 'Check your connection and try again.'
          }
          actionLabel={notFound ? undefined : 'Try again'}
          onAction={notFound ? undefined : () => void invite.refetch()}
        />
      </Screen>
    );
  }
  const g = invite.data;
  if (!g || !me.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <SkeletonGroup accessibilityLabel="Loading invite">
          <Skeleton height={80} />
          <Skeleton height={240} />
        </SkeletonGroup>
      </Screen>
    );
  }

  const member = g.members.some((m) => m.member.user_id === me.data.id && m.status !== 'left');
  const full = joinedCount(g) >= g.member_count;
  const contribution = fromApiMoney(g.contribution);
  const blocked = member
    ? null
    : g.status !== 'forming'
      ? 'This ajo has already started, so it is not taking new people.'
      : full
        ? 'This ajo is full.'
        : null;

  return (
    <Screen
      header={header}
      edges={['top', 'bottom']}
      footer={
        member ? (
          <Button label="Open ajo" onPress={() => openGroup(g.id)} />
        ) : blocked ? undefined : (
          <Button
            label="Join ajo"
            disabled={!agreed || !naira}
            onPress={() => {
              accept.resetIntent();
              setConfirming(true);
            }}
          />
        )
      }
    >
      <View style={{ gap: spacing[1] }}>
        <Text variant="title">{g.name}</Text>
        <Text variant="bodySmall" color="textMuted">
          {g.created_by.name} invited you to save together.
        </Text>
      </View>

      {member && (
        <Text variant="bodySmall" color="success">
          You are already in this ajo.
        </Text>
      )}
      {blocked && (
        <Text variant="bodySmall" color="danger" accessibilityRole="alert">
          {blocked}
        </Text>
      )}

      <AjoDetails group={g} meId={me.data.id} />

      {!member && !blocked && (
        <Checkbox
          label={`I'll pay ${contributionLabel(contribution, g.frequency)} from my naira account until everyone has had a turn`}
          checked={agreed}
          onChange={setAgreed}
        />
      )}

      <ConfirmSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        subtitle={`Join ${g.name}: ${formatMoney(contribution)} each turn`}
        onApproved={run}
        error={error}
      />
    </Screen>
  );
}
