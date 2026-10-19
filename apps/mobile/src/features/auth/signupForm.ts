import type { Schema } from '@nem/contracts';
import {
  dateOfBirthSchema,
  emailSchema,
  parseDisplayDate,
  personNameSchema,
  phoneSchema,
  PRIVACY_VERSION,
  TERMS_VERSION,
} from '@nem/shared';
import { z } from 'zod';

// The sign-up details form (AUTH-1). Fields hold what the user typed; parsing
// turns them into the API's shapes (E.164 phone, ISO date of birth).

export const signupFormSchema = z.object({
  firstName: personNameSchema('first name'),
  lastName: personNameSchema('last name'),
  email: emailSchema,
  phone: phoneSchema,
  dateOfBirth: z
    .string()
    .transform((value, ctx) => {
      const iso = parseDisplayDate(value);
      if (iso) return iso;
      ctx.addIssue({
        code: 'custom',
        message: value.trim() ? 'Enter a real date as DD/MM/YYYY' : 'Enter your date of birth',
      });
      return z.NEVER;
    })
    .pipe(dateOfBirthSchema),
  consent: z.boolean().refine(Boolean, 'Agree to the terms and privacy policy to continue'),
});

export type SignupFormInput = z.input<typeof signupFormSchema>;
export type SignupFormValues = z.output<typeof signupFormSchema>;
export type SignupField = keyof SignupFormInput;

export const EMPTY_SIGNUP_FORM: SignupFormInput = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  dateOfBirth: '',
  consent: false,
};

/** The NDPA consent record is stamped with the moment the user submits. */
export function toSignupRequest(values: SignupFormValues, now: Date): Schema<'SignupRequest'> {
  return {
    first_name: values.firstName,
    last_name: values.lastName,
    email: values.email,
    phone: values.phone,
    date_of_birth: values.dateOfBirth,
    consent: {
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
      accepted_at: now.toISOString(),
    },
  };
}

const FIELD_BY_POINTER: Record<string, SignupField> = {
  '/first_name': 'firstName',
  '/last_name': 'lastName',
  '/email': 'email',
  '/phone': 'phone',
  '/date_of_birth': 'dateOfBirth',
};

/** Maps a server field error (JSON Pointer) onto the form; consent errors land on the checkbox. */
export function fieldForPointer(pointer: string): SignupField | null {
  if (pointer.startsWith('/consent')) return 'consent';
  return FIELD_BY_POINTER[pointer] ?? null;
}

/** Keeps digits only and adds the slashes as the user types: "05031994" → "05/03/1994". */
export function formatDateEntry(text: string): string {
  const digits = text.replace(/\D/g, '').slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join('/');
}
