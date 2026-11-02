import { NEMTAG_MAX_LENGTH } from '@nem/shared';
import { useRouter } from 'expo-router';
import { AtSign, CalendarClock } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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

/** Changing your @nemtag (AUTH-10), with the rules that keep payments safe. */
export function NemtagChangeScreen() {
  const router = useRouter();
  const toast = useToast();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const me = useRepoQuery('users', 'getMe');
  const [input, setInput] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const user = me.data;
  const { tag, available, checking, suggestions, status } = useNemtagCheck(input, user?.nemtag);
  const save = useRepoMutation('users', 'setNemtag', { invalidates: [queryKeys.domain('users')] });

  const header = <SendHeader title={t('profile.change.title')} />;
  if (!user) {
    return (
      <Screen header={header} edges={['top', 'bottom']}>
        {me.isError ? (
          <ErrorState title={t('common.profileFailed')} onRetry={() => me.refetch()} />
        ) : (
          <SkeletonGroup accessibilityLabel={t('common.loading')}>
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
          title={t('profile.change.yoursForNow', { tag: user.nemtag })}
          message={t('profile.change.lockedMessage', { rule: nemtagRuleText(user, now) })}
          actionLabel={t('common.done')}
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
          toast.show({ message: t('profile.change.done', { tag }), tone: 'success' });
          router.back();
        },
        onError: (e) =>
          setError(
            isApiError(e) && e.problem.code === 'nemtag_taken'
              ? t('profile.change.taken', { tag })
              : isApiError(e) && e.problem.code === 'offline'
                ? t('common.offline')
                : isApiError(e)
                  ? (e.problem.detail ?? e.problem.title)
                  : t('profile.change.failed'),
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
        label={available ? t('profile.change.changeTo', { tag }) : t('profile.change.button')}
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
            {t('profile.change.current')}
          </Text>
          <Text variant="h2">{`@${user.nemtag}`}</Text>
        </View>
      )}

      <Card variant="outline">
        <View style={{ gap: spacing[2] }}>
          {t('profile.change.rules', { returnObjects: true }).map((rule) => (
            <Text key={rule} variant="bodySmall" color="textMuted">
              {`• ${rule}`}
            </Text>
          ))}
        </View>
      </Card>

      <View style={{ gap: spacing[3] }}>
        <TextField
          label={t('profile.change.new')}
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
              {t('profile.change.tryThese')}
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
        title={t('profile.change.confirmTitle', { tag })}
        message={
          user.nemtag
            ? t('profile.change.confirmReserved', { tag: user.nemtag })
            : t('profile.change.confirmFirst')
        }
        confirmLabel={t('common.change')}
        onConfirm={change}
        onCancel={() => setConfirming(false)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
});
