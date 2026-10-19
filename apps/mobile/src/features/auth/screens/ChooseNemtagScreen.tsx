import { NEMTAG_MAX_LENGTH, nemtagIdeas, nemtagProblem, normalizeNemtag } from '@nem/shared';
import { AtSign, Check, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Button, Icon, Screen, Text, TextField } from '@/components';
import { isApiError } from '@/data';
import { queryKeys, useRepoMutation, useRepoQuery } from '@/lib/query';
import { useSessionStore } from '@/stores';
import { useTheme } from '@/theme';

import { SignupStepHeader } from '../components/SignupStepHeader';
import { useSignOut } from '../hooks/useSessionActions';

/** Waits for typing to pause, so the bank is asked once per pause, not per key. */
export const NEMTAG_CHECK_DELAY_MS = 400;

function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * The last onboarding step (AUTH-10): a unique @nemtag friends can pay instead
 * of an account number. Shape rules are checked as the user types; availability
 * is asked of the bank once typing pauses, with ideas when a tag is taken.
 * Saving it opens Home through the route gate.
 */
export function ChooseNemtagScreen() {
  const { spacing } = useTheme();
  const nemtagChosen = useSessionStore((s) => s.nemtagChosen);
  const signOut = useSignOut();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string>();

  const tag = normalizeNemtag(input);
  const shape = tag ? nemtagProblem(tag) : null;
  const settled = useDebounced(tag, NEMTAG_CHECK_DELAY_MS);
  const ready = tag !== '' && shape === null;

  const me = useRepoQuery('users', 'getMe');
  const availability = useRepoQuery(
    'users',
    'checkNemtag',
    { path: { nemtag: settled } },
    { enabled: ready && settled === tag, staleTime: 10_000 },
  );
  const save = useRepoMutation('users', 'setNemtag', { invalidates: [queryKeys.domain('users')] });

  const result = ready && settled === tag ? availability.data : undefined;
  const checking = ready && (settled !== tag || availability.isFetching);
  const available = result?.nemtag === tag && result.available;
  const ideas = me.data ? nemtagIdeas(me.data.first_name, me.data.last_name) : [];
  const suggestions = result && !result.available ? result.suggestions.slice(0, 3) : [];

  const choose = (next: string) => {
    setInput(next);
    setError(undefined);
  };

  const submit = () => {
    if (!available) return;
    save.mutate(
      { body: { nemtag: tag } },
      {
        onSuccess: () => nemtagChosen(),
        onError: (e) =>
          setError(
            isApiError(e) && e.problem.code === 'nemtag_taken'
              ? `Someone just took @${tag}. Try another.`
              : isApiError(e) && e.problem.code === 'offline'
                ? "You're offline. Reconnect and try again."
                : "We couldn't save your @nemtag. Try again.",
          ),
      },
    );
  };

  const status = (() => {
    if (!tag) return null;
    if (shape) return { tone: 'danger' as const, text: shape };
    if (checking) return { tone: 'textMuted' as const, text: `Checking @${tag}…` };
    if (availability.isError) {
      return { tone: 'danger' as const, text: "We couldn't check right now. Try again." };
    }
    if (available) return { tone: 'success' as const, text: `@${tag} is yours if you want it` };
    if (result) return { tone: 'danger' as const, text: `@${tag} is taken` };
    return null;
  })();

  const footer = (
    <View style={{ padding: spacing[4], gap: spacing[2] }}>
      {error && (
        <Text variant="bodySmall" color="danger" accessibilityRole="alert">
          {error}
        </Text>
      )}
      <Button
        label={available ? `Claim @${tag}` : 'Claim @nemtag'}
        loading={save.isPending}
        disabled={!available}
        fullWidth
        onPress={submit}
      />
      <Button label="Sign out" variant="ghost" size="sm" onPress={() => void signOut()} />
    </View>
  );

  const StatusIcon = status?.tone === 'success' ? Check : X;

  return (
    <Screen
      header={<SignupStepHeader label="Last step" />}
      footer={footer}
      padded
      edges={['top', 'bottom']}
    >
      <View style={{ gap: spacing[2] }}>
        <Text variant="h1">Choose your @nemtag</Text>
        <Text color="textMuted">
          Friends can pay you with your @nemtag instead of your account number. Use 3 to 20 letters,
          numbers or _, starting with a letter.
        </Text>
      </View>

      <View style={{ gap: spacing[3] }}>
        <TextField
          label="@nemtag"
          leadingIcon={AtSign}
          value={input}
          onChangeText={choose}
          maxLength={NEMTAG_MAX_LENGTH + 1}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username-new"
          textContentType="username"
          returnKeyType="done"
          onSubmitEditing={submit}
          autoFocus
        />
        {status && (
          <View
            style={[styles.row, { gap: spacing[1] }]}
            accessible
            accessibilityLiveRegion="polite"
            accessibilityLabel={status.text}
          >
            {status.tone === 'textMuted' ? (
              <ActivityIndicator size="small" />
            ) : (
              <Icon icon={StatusIcon} size="sm" color={status.tone} />
            )}
            <Text variant="bodySmall" color={status.tone}>
              {status.text}
            </Text>
          </View>
        )}
        {(suggestions.length > 0 || (!tag && ideas.length > 0)) && (
          <View style={{ gap: spacing[2] }}>
            <Text variant="label" color="textMuted">
              {tag ? 'Try one of these' : 'Ideas'}
            </Text>
            <View style={[styles.chips, { gap: spacing[2] }]}>
              {(tag ? suggestions : ideas).map((idea) => (
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
});
