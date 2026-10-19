import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import { Controller, useForm } from 'react-hook-form';
import { StyleSheet, View } from 'react-native';

import { Button, Checkbox, IconButton, Screen, Text, TextField } from '@/components';
import { isApiError } from '@/data';
import { useRepoMutation } from '@/lib/query';
import { useTheme } from '@/theme';

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

const SIGNUP_STEPS = 4;

/** Step 1 of sign-up: who you are (AUTH-1). The bank emails a code for step 2. */
export function SignUpScreen() {
  const router = useRouter();
  const { spacing } = useTheme();
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
          if (!placed) setError('root.server', { message: `${error.message}. Try again.` });
        },
      },
    );
  });

  const header = (
    <View style={[styles.header, { paddingHorizontal: spacing[4], gap: spacing[2] }]}>
      {router.canGoBack() && (
        <IconButton
          icon={ArrowLeft}
          accessibilityLabel="Back"
          variant="ghost"
          onPress={() => router.back()}
        />
      )}
      <Text variant="label" color="textMuted" style={styles.flex}>
        Step 1 of {SIGNUP_STEPS}
      </Text>
    </View>
  );

  const footer = (
    <View style={{ padding: spacing[4], gap: spacing[2] }}>
      {errors.root?.server && (
        <Text variant="bodySmall" color="danger" accessibilityRole="alert">
          {errors.root.server.message}
        </Text>
      )}
      <Button label="Continue" loading={signup.isPending} fullWidth onPress={() => void submit()} />
    </View>
  );

  return (
    <Screen header={header} footer={footer} padded edges={['top', 'bottom']}>
      <View style={{ gap: spacing[2] }}>
        <Text variant="h1">Create your account</Text>
        <Text color="textMuted">
          Use your legal name as it appears on your ID. We will email you a code to confirm it is
          you.
        </Text>
      </View>

      <View style={{ gap: spacing[4] }}>
        <Controller
          control={control}
          name="firstName"
          render={({ field }) => (
            <TextField
              ref={field.ref}
              label="First name"
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
              label="Last name"
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
              label="Email"
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
              label="Phone number"
              help="A Nigerian mobile number. We send security alerts to it."
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
              label="Date of birth"
              help="You must be 18 or older."
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
              label="I agree to the Terms of Service and the Privacy Policy"
              help="Nem Bank processes your details under the Nigeria Data Protection Act 2023."
              checked={field.value}
              onChange={field.onChange}
              error={errors.consent?.message}
            />
          )}
        />
      </View>

      <Button
        label="I already have an account"
        variant="ghost"
        size="sm"
        onPress={() => router.replace('/login')}
        style={styles.start}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  flex: { flex: 1 },
  start: { alignSelf: 'flex-start' },
});
