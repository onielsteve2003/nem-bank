import { formatMoney, nemtagProblem, normalizeNemtag } from '@nem/shared';
import { useRouter } from 'expo-router';
import { AtSign, Link2, Play, Share2, XCircle } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Share, View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  Dialog,
  ErrorState,
  Screen,
  SectionHeader,
  Skeleton,
  SkeletonGroup,
  Text,
  TextField,
} from '@/components';
import { ConfirmSheet } from '@/features/transfers/components/ConfirmSheet';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { sendErrorMessage } from '@/features/transfers/confirm';
import { isApiError } from '@/data/errors';
import { fromApiMoney } from '@/lib/money';
import { useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { AJO_STATUS, groupSubtitle, inviteMessage, joinedCount } from '../ajo';
import { AjoDashboard } from '../components/AjoDashboard';
import { AjoDetails } from '../components/AjoDetails';

/**
 * One ajo group (AJO-1..5). While it is forming: invite by link or @nemtag,
 * see who has joined, and (for the organiser) start it once everyone is in, or
 * cancel it. Members who are not the organiser can leave. Once it runs, the
 * dashboard shows the pot, this turn's payments, the schedule and defaults.
 */
export function AjoGroupScreen({ id }: { id: string }) {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const group = useRepoQuery('ajo', 'getGroup', { path: { group_id: id } });
  const me = useRepoQuery('users', 'getMe');
  const [tag, setTag] = useState('');
  const [tagError, setTagError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string>();
  const [leaving, setLeaving] = useState(false);
  const invite = useRepoMutation('ajo', 'invite', { invalidates: [['ajo']] });
  const leave = useRepoMutation('ajo', 'leave', { invalidates: [['ajo']] });
  const start = useRepoMutation('ajo', 'start', {
    invalidates: [['ajo'], ['accounts'], ['transactions']],
  });

  const g = group.data;
  if (group.isError || !g) {
    return (
      <Screen header={<SendHeader title={t('ajo.title')} />} edges={['top', 'bottom']}>
        {group.isError ? (
          <ErrorState title={t('ajo.group.failed')} onRetry={() => group.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel={t('ajo.group.loading')}>
            <Skeleton height={120} />
            <Skeleton height={240} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const isOrganiser = me.data?.id === g.created_by.user_id;
  const forming = g.status === 'forming';
  const full = joinedCount(g) >= g.member_count;
  const contribution = fromApiMoney(g.contribution);

  const share = async () => {
    // Asking the bank for the invite also returns the link with a fresh expiry.
    const link = await invite.mutateAsync({ path: { group_id: id }, body: {} });
    await Share.share({ message: inviteMessage(g, link.invite_url) });
  };
  const addTag = () => {
    const clean = normalizeNemtag(tag);
    const problem = nemtagProblem(clean);
    if (problem) {
      setTagError(problem);
      return;
    }
    setTagError(undefined);
    invite.mutate(
      { path: { group_id: id }, body: { nemtags: [clean] } },
      {
        onSuccess: () => setTag(''),
        onError: (e) => setTagError(isApiError(e) ? e.problem.title : t('ajo.group.inviteFailed')),
      },
    );
  };
  const runStart = async () => {
    setStartError(undefined);
    try {
      await start.mutateAsync({ path: { group_id: id } });
      setStarting(false);
      return true;
    } catch (e) {
      setStartError(sendErrorMessage(e as Error).message);
      return false;
    }
  };

  return (
    <Screen
      header={<SendHeader title={g.name} />}
      edges={['top', 'bottom']}
      onRefresh={() => void group.refetch()}
      refreshing={group.isRefetching}
    >
      <View style={[{ gap: spacing[1] }]}>
        <Badge label={AJO_STATUS[g.status].label} tone={AJO_STATUS[g.status].tone} />
        <Text variant="bodySmall" color="textMuted">
          {groupSubtitle(g)}
        </Text>
      </View>

      {forming && (
        <View style={{ gap: spacing[2] }}>
          <SectionHeader title={t(full ? 'ajo.group.everyoneIn' : 'ajo.group.invitePeople')} />
          {!full && (
            <Card>
              <View style={{ gap: spacing[3] }}>
                <Button
                  label={t('ajo.group.shareLink')}
                  icon={Share2}
                  variant="secondary"
                  loading={invite.isPending && !tag}
                  onPress={() => void share()}
                />
                <TextField
                  label={t('ajo.group.addByTag')}
                  placeholder={t('ajo.group.tagPlaceholder')}
                  leadingIcon={AtSign}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={tag}
                  onChangeText={(text) => {
                    setTag(text);
                    setTagError(undefined);
                  }}
                  onSubmitEditing={addTag}
                  error={tagError}
                />
                <Button
                  label={t('ajo.group.add')}
                  icon={Link2}
                  variant="ghost"
                  disabled={!tag.trim()}
                  loading={invite.isPending && Boolean(tag)}
                  onPress={addTag}
                />
              </View>
            </Card>
          )}
          {isOrganiser ? (
            <>
              <Button
                label={t('ajo.group.start')}
                icon={Play}
                disabled={!full}
                onPress={() => {
                  setStartError(undefined);
                  setStarting(true);
                }}
              />
              <Text variant="caption" color="textMuted">
                {full
                  ? t('ajo.group.startCollects', {
                      amount: formatMoney(contribution, { trimZeroMinor: true }),
                    })
                  : t('ajo.group.startWhenFull', { count: g.member_count })}
              </Text>
            </>
          ) : (
            <Text variant="caption" color="textMuted">
              {t('ajo.group.organiserStarts', { name: g.created_by.name })}
            </Text>
          )}
        </View>
      )}

      {(g.status === 'active' || g.status === 'completed') && (
        <AjoDashboard group={g} meId={me.data?.id} />
      )}

      <AjoDetails group={g} meId={me.data?.id} />

      {forming && (
        <Button
          label={t(isOrganiser ? 'ajo.group.cancel' : 'ajo.group.leave')}
          icon={XCircle}
          variant="ghost"
          onPress={() => setLeaving(true)}
        />
      )}

      <ConfirmSheet
        open={starting}
        onClose={() => setStarting(false)}
        subtitle={t('ajo.group.startStep', { name: g.name, amount: formatMoney(contribution) })}
        onApproved={runStart}
        error={startError}
      />
      <Dialog
        open={leaving}
        title={t(isOrganiser ? 'ajo.group.cancelTitle' : 'ajo.group.leaveTitle', { name: g.name })}
        message={isOrganiser ? t('ajo.group.cancelMessage') : t('ajo.group.leaveMessage')}
        confirmLabel={t(isOrganiser ? 'ajo.group.cancel' : 'ajo.group.leaveConfirm')}
        cancelLabel={t('common.keepIt')}
        destructive
        loading={leave.isPending}
        onCancel={() => setLeaving(false)}
        onConfirm={() =>
          leave.mutate(
            { path: { group_id: id } },
            {
              onSuccess: () => {
                setLeaving(false);
                router.back();
              },
              onError: () => setLeaving(false),
            },
          )
        }
      />
    </Screen>
  );
}
