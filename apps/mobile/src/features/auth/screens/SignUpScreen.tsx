import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'expo-router';
import { Controller, useForm } from 'react-hook-form';
import { StyleSheet, View } from 'react-native';

import { Button, Checkbox, Screen, Text, TextField } from '@/components';
import { isApiError } from '@/data';
import { useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

import { SignupStepHeader } from '../components/SignupStepHeader';
import {
  EMPTY_SIGNUP_FORM,
  fieldForPointer,
  formatDateEntry,
  signupFormSchema,
  toSignupRequest,
  type SignupFormInput,
  type SignupFormValues,
} from '../signupForm';
import { useSignupStore } from '../signupStore';
import { useTranslation } from 'react-i18next';

/** Step 1 of sign-up: who you are (AUTH-1). The bank emails a code for step 2. */
export function SignUpScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
  const { t } = useTranslation();
  const startSignup = useSignupStore((s) => s.start);

  const {
    control,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<SignupFormInput, unknown, SignupFormValues>({
    resolver: zodResolver(signupFormSchema),
    defaultValues: EMPTY_SIGNUP_FORM,
    mode: 'onTouched',
  });

  const signup = useRepoMutation('auth', 'startSignup', { invalidates: [] });

  const submit = handleSubmit((values) => {
    const request = toSignupRequest(values, new Date());
    signup.mutate(
      { body: request },
      {
        onSuccess: (started) => {
          startSignup(started, request);
          router.push('/verify-email');
        },
        onError: (error) => {
          // Field errors from the server land on their fields; the rest show above the button.
          let placed = false;
          for (const fieldError of isApiError(error) ? (error.problem.errors ?? []) : []) {
            const field = fieldForPointer(fieldError.field);
            if (field) {
              setError(field, { message: fieldError.message }, { shouldFocus: !placed });
              placed = true;
            }
          }
          if (!placed) {
            setError('root.server', {
              message: t('common.problemTryAgain', { problem: error.message }),
            });
          }
        },
      },
    );
  });

  const header = <SignupStepHeader step={1} />;

  const footer = (
    <View style={{ padding: spacing[4], gap: spacing[2] }}>
      {errors.root?.server && (
        <Text variant="bodySmall" color="danger" accessibilityRole="alert">
          {errors.root.server.message}
        </Text>
      )}
      <Button
        label={t('common.continue')}
        loading={signup.isPending}
        fullWidth
        onPress={() => void submit()}
      />
    </View>
  );

  return (
    <Screen header={header} footer={footer} padded edges={['top', 'bottom']}>
      <View style={{ gap: spacing[2] }}>
        <Text variant="h1">{t('auth.signup.title')}</Text>
        <Text color="textMuted">{t('auth.signup.intro')}</Text>
      </View>

      <View style={{ gap: spacing[4] }}>
        <Controller
          control={control}
          name="firstName"
          render={({ field }) => (
            <TextField
              ref={field.ref}
              label={t('auth.signup.firstName')}
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              error={errors.firstName?.message}
              autoCapitalize="words"
              autoComplete="given-name"
              textContentType="givenName"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => setFocus('lastName')}
            />
          )}
        />
        <Controller
          control={control}
          name="lastName"
          render={({ field }) => (
            <TextField
              ref={field.ref}
              label={t('auth.signup.lastName')}
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              error={errors.lastName?.message}
              autoCapitalize="words"
              autoComplete="family-name"
              textContentType="familyName"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => setFocus('email')}
            />
          )}
        />
        <Controller
          control={control}
          name="email"
          render={({ field }) => (
            <TextField
              ref={field.ref}
              label={t('auth.signup.email')}
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              error={errors.email?.message}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => setFocus('phone')}
            />
          )}
        />
        <Controller
          control={control}
          name="phone"
          render={({ field }) => (
            <TextField
              ref={field.ref}
              label={t('auth.signup.phone')}
              help={t('auth.signup.phoneHelp')}
              placeholder="0803 123 4567"
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              error={errors.phone?.message}
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => setFocus('dateOfBirth')}
            />
          )}
        />
        <Controller
          control={control}
          name="dateOfBirth"
          render={({ field }) => (
            <TextField
              ref={field.ref}
              label={t('auth.signup.dateOfBirth')}
              help={t('auth.signup.dateOfBirthHelp')}
              placeholder="DD/MM/YYYY"
              value={field.value}
              onChangeText={(text) => field.onChange(formatDateEntry(text))}
              onBlur={field.onBlur}
              error={errors.dateOfBirth?.message}
              keyboardType="number-pad"
              autoComplete="birthdate-full"
              maxLength={10}
            />
          )}
        />
        <Controller
          control={control}
          name="consent"
          render={({ field }) => (
            <Checkbox
              label={t('auth.signup.consent')}
              help={t('auth.signup.consentHelp')}
              checked={field.value}
              onChange={field.onChange}
              error={errors.consent?.message}
            />
          )}
        />
      </View>

      <Button
        label={t('auth.signup.haveAccount')}
        variant="ghost"
        size="sm"
        onPress={() => router.replace('/login')}
        style={styles.start}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  start: { alignSelf: 'flex-start' },
});
