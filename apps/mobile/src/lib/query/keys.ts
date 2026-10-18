import type { Domain, Repositories } from '@/data';

// One key shape for every server read: [domain, method, input]. Invalidation
// works on prefixes, so ['transfers'] refreshes the whole domain and
// ['transfers', 'get'] every transfer detail, whatever its input.

export type MethodOf<D extends Domain> = Extract<keyof Repositories[D], string>;

type Fn<D extends Domain, M extends MethodOf<D>> = Repositories[D][M] extends (
  ...args: infer A
) => infer R
  ? { args: A; result: Awaited<R> }
  : never;

export type InputOf<D extends Domain, M extends MethodOf<D>> = Fn<D, M>['args'][0];
export type OutputOf<D extends Domain, M extends MethodOf<D>> = Fn<D, M>['result'];

export const queryKeys = {
  domain: <D extends Domain>(domain: D) => [domain] as const,
  method: <D extends Domain, M extends MethodOf<D>>(domain: D, method: M) =>
    [domain, method] as const,
  /** `null` stands for "no input", so `list()` and `list(undefined)` share one cache entry. */
  op: <D extends Domain, M extends MethodOf<D>>(domain: D, method: M, input?: InputOf<D, M>) =>
    [domain, method, input ?? null] as const,
};

export type QueryKeyOf<D extends Domain, M extends MethodOf<D>> = ReturnType<
  typeof queryKeys.op<D, M>
>;
