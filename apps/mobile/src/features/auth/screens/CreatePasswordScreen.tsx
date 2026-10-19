import { checkPassword, PASSWORD_MAX_LENGTH } from '@nem/shared';
import { Redirect, useRouter } from 'expo-router';
import { Check } from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Icon, Screen, Text, TextField } from '@/components';
import { useTheme } from '@/theme';

import { PasswordStrengthMeter } from '../components/PasswordStrengthMeter';
import { SignupStepHeader } from '../components/SignupStepHeader';
import { useSignupStore } from '../signupStore';

/** Step 3 of sign-up: a password the meter and the bank both accept (AUTH-3). */
export function CreatePasswordScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const pending = useSignupStore((s) => s.pending);
  const savePassword = useSignupStore((s) => s.setPassword);
  const [password, setPassword] = useState(pending?.password ?? '');
  const [submitted, setSubmitted] = useState(false);

  const request = pending?.request;
  const check = useMemo(
    () =>
      checkPassword(password, {
        firstName: request?.first_name,
        lastName: request?.last_name,
        email: request?.email,
        dateOfBirth: request?.date_of_birth,
      }),
    [password, request],
  );

  if (!pending?.verificationToken) return <Redirect href="/sign-up" />;

  const submit = () => {
    setSubmitted(true);
    if (!check.acceptable) return;
    savePassword(password);
    router.push('/create-pin');
  };

  const footer = (
    <View style={{ padding: spacing[4] }}>
      <Button label="Continue" fullWidth onPress={submit} />
    </View>
  );

  return (
    <Screen header={<SignupStepHeader step={3} />} footer={footer} padded edges={['top', 'bottom']}>
      <View style={{ gap: spacing[2] }}>
        <Text variant="h1">Create a password</Text>
        <Text color="textMuted">
          You will use it to log in. A short phrase of three or four words is strong and easy to
          remember.
        </Text>
      </View>

      <View style={{ gap: spacing[3] }}>
        <TextField
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="new-password"
          textContentType="newPassword"
          passwordRules={`minlength: 10; maxlength: ${PASSWORD_MAX_LENGTH};`}
          maxLength={PASSWORD_MAX_LENGTH}
          error={submitted && !check.acceptable ? check.problems[0] : undefined}
          returnKeyType="done"
          onSubmitEditing={submit}
          autoFocus
        />
        {password.length > 0 && <PasswordStrengthMeter check={check} />}
        {password.length > 0 && check.tips.length > 0 && (
          <View style={{ gap: spacing[1] }}>
            {check.tips.slice(0, 2).map((tip) => (
              <Text key={tip} variant="bodySmall" color="textMuted">
                • {tip}
              </Text>
            ))}
          </View>
        )}
        {check.acceptable && (
          <View style={[styles.row, { gap: spacing[1] }]}>
            <Icon icon={Check} size="sm" color="success" />
            <Text variant="bodySmall" color="success">
              Good to go
            </Text>
          </View>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
