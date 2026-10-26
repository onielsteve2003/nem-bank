import { formatMoney, nemtagProblem, normalizeNemtag } from '@nem/shared';
import { useRouter } from 'expo-router';
import { AtSign, Link2, Play, Share2, XCircle } from 'lucide-react-native';
import { useState } from 'react';
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
import { AjoDetails } from '../components/AjoDetails';

/**
 * One ajo group (AJO-1, AJO-2). While it is forming: invite by link or
 * @nemtag, see who has joined, and (for the organiser) start it once everyone
 * is in, or cancel it. Members who are not the organiser can leave.
 */
export function AjoGroupScreen({ id }: { id: string }) {
  const router = useRouter();
  const { spacing } = useTheme();
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
      <Screen header={<SendHeader title="Ajo" />} edges={['top', 'bottom']}>
        {group.isError ? (
          <ErrorState title="We couldn't load this ajo" onRetry={() => group.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel="Loading ajo">
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
        onError: (e) =>
          setTagError(isApiError(e) ? e.problem.title : "We couldn't invite them. Try again."),
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
          <SectionHeader title={full ? 'Everyone is in' : 'Invite people'} />
          {!full && (
            <Card>
              <View style={{ gap: spacing[3] }}>
                <Button
                  label="Share invite link"
                  icon={Share2}
                  variant="secondary"
                  loading={invite.isPending && !tag}
                  onPress={() => void share()}
                />
                <TextField
                  label="Or add by Nem tag"
                  placeholder="@emeka"
                  leadingIcon={AtSign}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={tag}
                  onChangeText={(t) => {
                    setTag(t);
                    setTagError(undefined);
                  }}
                  onSubmitEditing={addTag}
                  error={tagError}
                />
                <Button
                  label="Add"
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
                label="Start ajo"
                icon={Play}
                disabled={!full}
                onPress={() => {
                  setStartError(undefined);
                  setStarting(true);
                }}
              />
              <Text variant="caption" color="textMuted">
                {full
                  ? `Starting collects the first ${formatMoney(contribution, { trimZeroMinor: true })} from each person.`
                  : `You can start once all ${g.member_count} people are in.`}
              </Text>
            </>
          ) : (
            <Text variant="caption" color="textMuted">
              {g.created_by.name} starts it once everyone is in. Nothing is paid until then.
            </Text>
          )}
        </View>
      )}

      <AjoDetails group={g} meId={me.data?.id} />

      {forming && (
        <Button
          label={isOrganiser ? 'Cancel ajo' : 'Leave ajo'}
          icon={XCircle}
          variant="ghost"
          onPress={() => setLeaving(true)}
        />
      )}

      <ConfirmSheet
        open={starting}
        onClose={() => setStarting(false)}
        subtitle={`Start ${g.name} and pay your first ${formatMoney(contribution)}`}
        onApproved={runStart}
        error={startError}
      />
      <Dialog
        open={leaving}
        title={isOrganiser ? `Cancel ${g.name}?` : `Leave ${g.name}?`}
        message={
          isOrganiser
            ? 'Everyone who joined is told it is off. Nothing has been paid yet.'
            : 'Your place goes back to the organiser. Nothing has been paid yet.'
        }
        confirmLabel={isOrganiser ? 'Cancel ajo' : 'Leave'}
        cancelLabel="Keep it"
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
