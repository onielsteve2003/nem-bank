import { z } from 'zod';

// Sign-up rules (AUTH-1), shared by the sign-up form and the mock bank so both
// reject the same input with the same words.

/** Versions of the documents a customer agrees to; bumping one asks everyone again. */
export const TERMS_VERSION = '2026-10';
export const PRIVACY_VERSION = '2026-10';
export const MIN_SIGNUP_AGE = 18;
const MAX_AGE = 120;

/** E.164 Nigerian mobile: +234, then 70x/71x/80x/81x/90x/91x and 8 more digits. */
const NG_MOBILE = /^\+234[789][01]\d{8}$/;

/**
 * Accepts the ways people write a Nigerian mobile number (0803 123 4567,
 * 803 123 4567, 234…, +234…, +234 0803…) and returns E.164, or null.
 */
export function normalizeNigerianPhone(input: string): string | null {
  const compact = input.replace(/[\s\-().]/g, '');
  let national: string;
  if (/^\+234\d+$/.test(compact)) national = compact.slice(4);
  else if (/^234\d{10,11}$/.test(compact)) national = compact.slice(3);
  else if (/^\d{10,11}$/.test(compact)) national = compact;
  else return null;
  if (national.length === 11 && national.startsWith('0')) national = national.slice(1);
  const e164 = `+234${national}`;
  return NG_MOBILE.test(e164) ? e164 : null;
}

/** Today's calendar date in Lagos (UTC+1 all year, no daylight saving). */
export function lagosToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 3_600_000).toISOString().slice(0, 10);
}

const isoParts = (iso: string) => iso.split('-').map(Number) as [number, number, number];

/** Whole years from an ISO date of birth to an ISO date. A 29 February birthday turns over on 1 March. */
export function ageOn(dateOfBirth: string, onDate: string): number {
  const [by, bm, bd] = isoParts(dateOfBirth);
  const [y, m, d] = isoParts(onDate);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** DD/MM/YYYY, the way Nigerians write dates, to ISO; null if it is not a real calendar date. */
export function parseDisplayDate(input: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input.trim());
  if (!match) return null;
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

export const personNameSchema = (what: string) =>
  z
    .string()
    .trim()
    .min(1, `Enter your ${what}`)
    .max(50, `Keep your ${what} under 50 characters`)
    .regex(/^\p{L}[\p{L}\p{M}' .-]*$/u, `Use letters only in your ${what}`);

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address').max(254, 'Enter a valid email address'));

const PHONE_MESSAGE = 'Enter a Nigerian mobile number, like 0803 123 4567';

/** Any common way of writing the number in, E.164 out. */
export const phoneSchema = z.string().transform((value, ctx) => {
  const e164 = normalizeNigerianPhone(value);
  if (e164) return e164;
  ctx.addIssue({ code: 'custom', message: PHONE_MESSAGE });
  return z.NEVER;
});

/** An ISO date of birth for someone 18 to 120 years old today in Lagos. */
export const dateOfBirthSchema = z.iso
  .date('Enter a real date')
  .refine(
    (dob) => ageOn(dob, lagosToday()) >= MIN_SIGNUP_AGE,
    `You must be ${MIN_SIGNUP_AGE} or older to open an account`,
  )
  .refine((dob) => ageOn(dob, lagosToday()) <= MAX_AGE, 'Check the year you were born');

/** The `SignupRequest` body, checked the way the server checks it. */
export const signupRequestSchema = z.object({
  first_name: personNameSchema('first name'),
  last_name: personNameSchema('last name'),
  email: emailSchema,
  phone: z.string().regex(NG_MOBILE, PHONE_MESSAGE),
  date_of_birth: dateOfBirthSchema,
  consent: z.object({
    terms_version: z.string().min(1),
    privacy_version: z.string().min(1),
    accepted_at: z.iso.datetime({ offset: true }),
  }),
});
