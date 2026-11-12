// Same switch as the mobile app: the console runs on the in-browser mock bank unless
// VITE_API_MODE=http points it at the Go API.

export type ApiMode = 'mock' | 'http';

export interface Env {
  apiMode: ApiMode;
  /** Origin of the Go API, no trailing slash. Empty in mock mode. */
  apiUrl: string;
}

export function readEnv(raw: Record<string, string | undefined>): Env {
  const mode = (raw.VITE_API_MODE ?? 'mock').trim();
  if (mode !== 'mock' && mode !== 'http') {
    throw new Error(`VITE_API_MODE must be "mock" or "http", got "${mode}".`);
  }
  if (mode === 'mock') return { apiMode: 'mock', apiUrl: '' };

  const url = (raw.VITE_API_URL ?? '').trim().replace(/\/+$/, '');
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw new Error('VITE_API_URL must be an http(s) URL when VITE_API_MODE=http.');
  }
  return { apiMode: 'http', apiUrl: url };
}

export const env: Env = readEnv(import.meta.env as Record<string, string | undefined>);
