import { emailSchema, normalizeNigerianPhone } from '@nem/shared';
import { z } from 'zod';

import { isApiError } from '@/data';

// The login form (AUTH-7): email or +234 phone, and the password.

/** "Tolu@Example.com" → "tolu@example.com", "0803 123 4567" → "+2348031234567", else null. */
export function toLoginIdentifier(input: string): string | null {
  const value = input.trim();
  if (value.includes('@')) {
    const email = emailSchema.safeParse(value);
    return email.success ? email.data : null;
  }
  return normalizeNigerianPhone(value);
}

export const loginFormSchema = z.object({
  identifier: z.string().transform((value, ctx) => {
    const identifier = toLoginIdentifier(value);
    if (identifier) return identifier;
    ctx.addIssue({
      code: 'custom',
      message: value.trim()
        ? 'Enter your email or a Nigerian mobile number'
        : 'Enter your email or phone number',
    });
    return z.NEVER;
  }),
  password: z.string().min(1, 'Enter your password'),
});

export type LoginFormInput = z.input<typeof loginFormSchema>;
export type LoginFormValues = z.output<typeof loginFormSchema>;

/** Never says which half was wrong, so the form cannot be used to find accounts. */
export function loginErrorMessage(error: unknown): string {
  if (!isApiError(error)) return "We couldn't log you in. Try again.";
  switch (error.problem.code) {
    case 'invalid_credentials':
      return 'That email, phone number or password is not right.';
    case 'rate_limited':
      return 'Too many tries. Wait a few minutes, or reset your password.';
    case 'offline':
      return "You're offline. Reconnect and try again.";
    default:
      return `${error.problem.title}. Try again.`;
  }
}
