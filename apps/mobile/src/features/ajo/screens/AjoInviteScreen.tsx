import { formatMoney } from '@nem/shared';
import { useRouter } from 'expo-router';
import { Users } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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

  const header = <SendHeader title={t('ajo.invite.title')} first />;
  if (invite.isError) {
    const notFound = isApiError(invite.error) && invite.error.problem.status === 404;
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <EmptyState
          icon={Users}
          title={t(notFound ? 'ajo.invite.invalidTitle' : 'ajo.invite.failedTitle')}
          message={notFound ? t('ajo.invite.invalidMessage') : t('errors.offlineMessage')}
          actionLabel={notFound ? undefined : t('common.tryAgain')}
          onAction={notFound ? undefined : () => void invite.refetch()}
        />
      </Screen>
    );
  }
  const g = invite.data;
  if (!g || !me.data) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <SkeletonGroup accessibilityLabel={t('ajo.invite.loading')}>
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
      ? t('ajo.invite.started')
      : full
        ? t('ajo.invite.full')
        : null;

  return (
    <Screen
      header={header}
      edges={['top', 'bottom']}
      footer={
        member ? (
          <Button label={t('ajo.invite.open')} onPress={() => openGroup(g.id)} />
        ) : blocked ? undefined : (
          <Button
            label={t('ajo.invite.join')}
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
          {t('ajo.invite.invitedYou', { name: g.created_by.name })}
        </Text>
      </View>

      {member && (
        <Text variant="bodySmall" color="success">
          {t('ajo.invite.alreadyIn')}
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
          label={t('ajo.invite.agree', {
            contribution: contributionLabel(contribution, g.frequency),
          })}
          checked={agreed}
          onChange={setAgreed}
        />
      )}

      <ConfirmSheet
        open={confirming}
        onClose={() => setConfirming(false)}
        subtitle={t('ajo.invite.joinStep', { name: g.name, amount: formatMoney(contribution) })}
        onApproved={run}
        error={error}
      />
    </Screen>
  );
}
