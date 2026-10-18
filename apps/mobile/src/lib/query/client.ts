import { QueryClient, type Query } from '@tanstack/react-query';

import { isApiError, type Domain } from '@/data';

// Query rules (architecture §7): reads retry briefly on transient failures and
// are served from the persisted cache offline; writes never retry on their own
// and never wait for the network to come back (ADR-10: no offline money queue).

export const MAX_QUERY_RETRIES = 2;
/** How long persisted data may be shown before it is dropped. */
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Network failures and 5xx are worth another try; a 4xx answer will not change. */
export function isTransient(error: unknown): boolean {
  if (!isApiError(error)) return !(error instanceof Error && error.name === 'AbortError');
  return error.status >= 500 || error.status === 408 || error.code === 'rate_limited';
}

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  return failureCount < MAX_QUERY_RETRIES && isTransient(error);
}

/** 0.5 s, 1 s, 2 s … capped at 8 s, honouring a server-sent `retry_at`. */
export function retryDelay(attempt: number, error: unknown): number {
  const retryAt = isApiError(error) ? error.problem.retry_at : undefined;
  if (retryAt) return Math.max(0, Math.min(Date.parse(retryAt) - Date.now(), 30_000));
  return Math.min(500 * 2 ** attempt, 8_000);
}

/**
 * Domains whose reads are never written to disk: sessions and tokens, revealed
 * card data and anything tied to a one-off challenge.
 */
const NOT_PERSISTED: ReadonlySet<Domain> = new Set(['auth', 'realtime', 'demo', 'privacy']);
const NOT_PERSISTED_METHODS = new Set([
  'reveal',
  'download',
  'getMyQr',
  'decodeQr',
  'quote',
  'createQuote',
]);

export function shouldPersistQuery(query: Query): boolean {
  if (query.state.status !== 'success') return false;
  const [domain, method] = query.queryKey as [Domain, string];
  return !NOT_PERSISTED.has(domain) && !NOT_PERSISTED_METHODS.has(method);
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Kept at least as long as the persisted copy, or restore would drop it.
        gcTime: PERSIST_MAX_AGE_MS,
        retry: shouldRetryQuery,
        retryDelay,
        // Show cached data offline and try the network when it is there.
        networkMode: 'offlineFirst',
        refetchOnReconnect: true,
      },
      mutations: {
        // A mutation runs once per tap. Retrying is the user's decision, and a
        // money retry must reuse its idempotency key (useMoneyMutation).
        retry: false,
        // 'online' would pause offline and fire later on its own: an offline queue.
        networkMode: 'always',
      },
    },
  });
}
