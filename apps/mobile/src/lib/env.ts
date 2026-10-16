import { z } from 'zod';

// Unset and empty variables both mean "not provided".
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const RawEnvSchema = z.object({
  EXPO_PUBLIC_API_MODE: optional(z.enum(['mock', 'http'])),
  EXPO_PUBLIC_API_URL: optional(z.url({ protocol: /^https?$/ })),
});

export type RawEnv = Record<keyof z.infer<typeof RawEnvSchema>, string | undefined>;

export type Env =
  { apiMode: 'mock'; apiUrl: string | undefined } | { apiMode: 'http'; apiUrl: string };

const fail = (message: string): never => {
  throw new Error(`Invalid environment configuration:\n${message}`);
};

/** Validates raw environment values. Throws one readable error listing every problem. */
export function parseEnv(raw: RawEnv): Env {
  const result = RawEnvSchema.safeParse(raw);
  if (!result.success) return fail(z.prettifyError(result.error));

  const apiUrl = result.data.EXPO_PUBLIC_API_URL?.replace(/\/+$/, '');
  if (result.data.EXPO_PUBLIC_API_MODE === 'http') {
    return {
      apiMode: 'http',
      apiUrl: apiUrl ?? fail('✖ EXPO_PUBLIC_API_URL is required when EXPO_PUBLIC_API_MODE=http'),
    };
  }
  return { apiMode: 'mock', apiUrl };
}

// Each variable must be read by its full static name: Metro inlines
// `process.env.EXPO_PUBLIC_*` at build time and cannot see dynamic lookups.
export const env: Env = parseEnv({
  EXPO_PUBLIC_API_MODE: process.env.EXPO_PUBLIC_API_MODE,
  EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
});
