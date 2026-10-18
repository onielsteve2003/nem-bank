import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseMutationOptions,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { useCallback, useRef } from 'react';

import { useRepositories, type ApiError, type Domain, type Repositories } from '@/data';
import { uuidv7 } from '@/lib/ids';

import { queryKeys, type InputOf, type MethodOf, type OutputOf, type QueryKeyOf } from './keys';

type Call = (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;

const callOf = (repos: Repositories, domain: Domain, method: string) =>
  (repos[domain] as unknown as Record<string, Call>)[method]!;

/** A read through a repository, keyed by [domain, method, input]. */
export function useRepoQuery<D extends Domain, M extends MethodOf<D>, Selected = OutputOf<D, M>>(
  domain: D,
  method: M,
  input?: InputOf<D, M>,
  options: Omit<
    UseQueryOptions<OutputOf<D, M>, ApiError, Selected, QueryKeyOf<D, M>>,
    'queryKey' | 'queryFn'
  > = {},
) {
  const repos = useRepositories();
  return useQuery({
    ...options,
    queryKey: queryKeys.op(domain, method, input),
    queryFn: ({ signal }) =>
      callOf(repos, domain, method)(input, { signal }) as Promise<OutputOf<D, M>>,
  });
}

interface MutationExtras {
  /** Query prefixes to refresh once the mutation succeeds. */
  invalidates?: QueryKey[];
}

/** A non-money write. It runs once; on failure the screen offers "Try again". */
export function useRepoMutation<D extends Domain, M extends MethodOf<D>>(
  domain: D,
  method: M,
  {
    invalidates = [[domain]],
    ...options
  }: Omit<UseMutationOptions<OutputOf<D, M>, ApiError, InputOf<D, M>>, 'mutationFn'> &
    MutationExtras = {},
) {
  const repos = useRepositories();
  const client = useQueryClient();
  return useMutation({
    ...options,
    mutationFn: (input) => callOf(repos, domain, method)(input) as Promise<OutputOf<D, M>>,
    onSuccess: async (...args) => {
      await Promise.all(invalidates.map((queryKey) => client.invalidateQueries({ queryKey })));
      await options.onSuccess?.(...args);
    },
  });
}

/** Methods whose input carries an idempotency key: the money-moving ones. */
type MoneyMethod<D extends Domain> = {
  [M in MethodOf<D>]: InputOf<D, M> extends { idempotencyKey: string } ? M : never;
}[MethodOf<D>];

type WithoutKey<T> = T extends { idempotencyKey: string } ? Omit<T, 'idempotencyKey'> : never;

const sameRequest = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A money-moving write (TRF-5). The idempotency key is made once per intent and
 * kept across manual retries of the *same* request, so "Try again" after a timeout
 * can never debit twice. Changing the request, or a success, starts a new intent.
 * It never retries on its own.
 */
export function useMoneyMutation<D extends Domain, M extends MoneyMethod<D>>(
  domain: D,
  method: M,
  {
    invalidates = [[domain], ['accounts'], ['transactions']],
    ...options
  }: Omit<
    UseMutationOptions<OutputOf<D, M>, ApiError, WithoutKey<InputOf<D, M>>>,
    'mutationFn' | 'retry'
  > &
    MutationExtras = {},
) {
  const repos = useRepositories();
  const client = useQueryClient();
  const intent = useRef<{ key: string; request: unknown } | null>(null);

  const keyFor = useCallback((request: unknown) => {
    if (!intent.current || !sameRequest(intent.current.request, request)) {
      intent.current = { key: uuidv7(), request };
    }
    return intent.current.key;
  }, []);

  const mutation = useMutation({
    ...options,
    retry: false,
    mutationFn: (request) =>
      callOf(repos, domain, method)({ ...request, idempotencyKey: keyFor(request) }) as Promise<
        OutputOf<D, M>
      >,
    onSuccess: async (...args) => {
      intent.current = null;
      await Promise.all(invalidates.map((queryKey) => client.invalidateQueries({ queryKey })));
      await options.onSuccess?.(...args);
    },
  });

  /** Abandons the current intent (the user backed out): the next tap gets a new key. */
  const resetIntent = useCallback(() => {
    intent.current = null;
    mutation.reset();
  }, [mutation]);

  return { ...mutation, resetIntent };
}
