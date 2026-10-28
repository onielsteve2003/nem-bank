import { NEMTAG_MAX_LENGTH, nemtagIdeas } from '@nem/shared';
import { AtSign } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Screen, Text, TextField } from '@/components';
import { isApiError } from '@/data';
import { queryKeys, useRepoMutation, useRepoQuery } from '@/lib/query';
import { useSessionStore } from '@/stores';
import { useTheme } from '@/theme';

import { NemtagStatusLine } from '../components/NemtagStatusLine';
import { SignupStepHeader } from '../components/SignupStepHeader';
import { useSignOut } from '../hooks/useSessionActions';
import { useNemtagCheck } from '../useNemtagCheck';

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

  const { tag, available, checking, suggestions, status } = useNemtagCheck(input);
  const me = useRepoQuery('users', 'getMe');
  const save = useRepoMutation('users', 'setNemtag', { invalidates: [queryKeys.domain('users')] });
  const ideas = me.data ? nemtagIdeas(me.data.first_name, me.data.last_name) : [];

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
        {status && <NemtagStatusLine status={status} checking={checking} />}
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
  chips: { flexDirection: 'row', flexWrap: 'wrap' },
});
