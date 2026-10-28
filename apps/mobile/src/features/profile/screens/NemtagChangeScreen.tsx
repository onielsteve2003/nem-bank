import { NEMTAG_MAX_LENGTH } from '@nem/shared';
import { useRouter } from 'expo-router';
import { AtSign, CalendarClock } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Screen,
  Skeleton,
  SkeletonGroup,
  Text,
  TextField,
  useToast,
} from '@/components';
import { isApiError } from '@/data';
import { NemtagStatusLine } from '@/features/auth/components/NemtagStatusLine';
import { useNemtagCheck } from '@/features/auth/useNemtagCheck';
import { SendHeader } from '@/features/transfers/components/SendHeader';
import { queryKeys, useRepoMutation, useRepoQuery } from '@/lib/query';
import { useTheme } from '@/theme';

import { nemtagLockedUntil, nemtagRuleText } from '../profile';

const RULES = [
  'You can change your @nemtag once every 30 days.',
  'Your old @nemtag stays reserved for you for 30 days, so nobody else can take it. You can switch back to it in that time.',
  'People who saved your old @nemtag will need the new one to pay you.',
];

/** Changing your @nemtag (AUTH-10), with the rules that keep payments safe. */
export function NemtagChangeScreen() {
  const router = useRouter();
  const toast = useToast();
  const { spacing } = useTheme();
  const me = useRepoQuery('users', 'getMe');
  const [input, setInput] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const user = me.data;
  const { tag, available, checking, suggestions, status } = useNemtagCheck(input, user?.nemtag);
  const save = useRepoMutation('users', 'setNemtag', { invalidates: [queryKeys.domain('users')] });

  const header = <SendHeader title="Change @nemtag" />;
  if (!user) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {me.isError ? (
          <ErrorState title="We couldn't load your profile" onRetry={() => me.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel="Loading">
            <Skeleton height={200} />
          </SkeletonGroup>
        )}
      </Screen>
    );
  }

  const now = new Date();
  if (nemtagLockedUntil(user, now)) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        <EmptyState
          icon={CalendarClock}
          title={`@${user.nemtag} is yours for now`}
          message={`${nemtagRuleText(user, now)}. A @nemtag can change once every 30 days.`}
          actionLabel="Done"
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  const choose = (next: string) => {
    setInput(next);
    setError(undefined);
  };

  const change = () => {
    setConfirming(false);
    save.mutate(
      { body: { nemtag: tag } },
      {
        onSuccess: () => {
          toast.show({ message: `You're @${tag} now`, tone: 'success' });
          router.back();
        },
        onError: (e) =>
          setError(
            isApiError(e) && e.problem.code === 'nemtag_taken'
              ? `Someone just took @${tag}. Try another.`
              : isApiError(e) && e.problem.code === 'offline'
                ? "You're offline. Reconnect and try again."
                : isApiError(e)
                  ? (e.problem.detail ?? e.problem.title)
                  : "We couldn't change your @nemtag. Try again.",
          ),
      },
    );
  };

  const footer = (
    <View style={{ gap: spacing[2] }}>
      {error && (
        <Text variant="bodySmall" color="danger" accessibilityRole="alert">
          {error}
        </Text>
      )}
      <Button
        label={available ? `Change to @${tag}` : 'Change @nemtag'}
        fullWidth
        disabled={!available}
        loading={save.isPending}
        onPress={() => setConfirming(true)}
      />
    </View>
  );

  return (
    <Screen header={header} edges={['top', 'bottom']} footer={footer}>
      {user.nemtag && (
        <View style={{ gap: spacing[1] }}>
          <Text variant="bodySmall" color="textMuted">
            Your @nemtag now
          </Text>
          <Text variant="h2">{`@${user.nemtag}`}</Text>
        </View>
      )}

      <Card variant="outline">
        <View style={{ gap: spacing[2] }}>
          {RULES.map((rule) => (
            <Text key={rule} variant="bodySmall" color="textMuted">
              {`• ${rule}`}
            </Text>
          ))}
        </View>
      </Card>

      <View style={{ gap: spacing[3] }}>
        <TextField
          label="New @nemtag"
          leadingIcon={AtSign}
          value={input}
          onChangeText={choose}
          maxLength={NEMTAG_MAX_LENGTH + 1}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username-new"
          textContentType="username"
          returnKeyType="done"
          onSubmitEditing={() => available && setConfirming(true)}
        />
        {status && <NemtagStatusLine status={status} checking={checking} />}
        {suggestions.length > 0 && (
          <View style={{ gap: spacing[2] }}>
            <Text variant="label" color="textMuted">
              Try one of these
            </Text>
            <View style={[styles.chips, { gap: spacing[2] }]}>
              {suggestions.map((idea) => (
                <Button
                  key={idea}
                  label={`@${idea}`}
                  variant="secondary"
                  size="sm"
                  onPress={() => choose(idea)}
                />
              ))}
            </View>
          </View>
        )}
      </View>

      <Dialog
        open={confirming}
        title={`Change to @${tag}?`}
        message={
          user.nemtag
            ? `You won’t be able to change it again for 30 days. @${user.nemtag} stays reserved for you until then.`
            : 'Friends can pay you with it straight away.'
        }
        confirmLabel="Change"
        onConfirm={change}
        onCancel={() => setConfirming(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
});
