import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BottomSheet, Button, Divider, PressableScale, Text, TextField } from '@/components';
import { isApiError } from '@/data';
import { useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { SECURITY_QUESTIONS } from '../security';

export type Props = {
  onClose: () => void;
  onSaved: () => void;
};

/** Smallest answer the bank accepts; anything shorter is easy to guess. */
const MIN_ANSWER = 3;

/**
 * A security question as a backup way to prove it is you (SEC-1 checkup).
 * The answer is write-only: the bank never sends it back. Mount only while open.
 */
export function SecurityQuestionSheet({ onClose, onSaved }: Props) {
  const { spacing } = useTheme();
  const [question, setQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string>();
  const save = useRepoMutation('security', 'setSecurityQuestion');
  const short = answer.trim().length < MIN_ANSWER;

  const submit = () => {
    if (!question || short) return;
    setError(undefined);
    save.mutate(
      { body: { question, answer: answer.trim() } },
      {
        onSuccess: onSaved,
        onError: (e) =>
          setError(
            isApiError(e) && e.problem.detail
              ? e.problem.detail
              : "We couldn't save it. Try again.",
          ),
      },
    );
  };

  return (
    <BottomSheet open onClose={onClose} title={question ? 'Your answer' : 'Pick a question'}>
      <View style={{ gap: spacing[4] }}>
        {!question ? (
          <View accessibilityRole="list">
            {SECURITY_QUESTIONS.map((q, i) => (
              <View key={q}>
                {i > 0 && <Divider />}
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={q}
                  onPress={() => setQuestion(q)}
                  style={[styles.option, { paddingVertical: spacing[3] }]}
                >
                  <Text variant="body">{q}</Text>
                </PressableScale>
              </View>
            ))}
          </View>
        ) : (
          <>
            <View style={{ gap: spacing[1] }}>
              <Text variant="bodyStrong">{question}</Text>
              <View style={styles.start}>
                <Button
                  label="Pick another question"
                  variant="ghost"
                  size="sm"
                  onPress={() => setQuestion(null)}
                />
              </View>
            </View>
            <TextField
              label="Answer"
              value={answer}
              onChangeText={setAnswer}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={100}
              help="Not case-sensitive. Pick something you won't forget, and don't share it."
              error={
                answer.length > 0 && short ? `Use ${MIN_ANSWER} characters or more` : undefined
              }
            />
            {error && (
              <Text variant="bodySmall" color="danger" accessibilityRole="alert">
                {error}
              </Text>
            )}
            <Button
              label="Save security question"
              disabled={short}
              loading={save.isPending}
              onPress={submit}
            />
          </>
        )}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  option: { minHeight: 44, justifyContent: 'center' },
  start: { alignItems: 'flex-start' },
});
