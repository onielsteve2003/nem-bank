import type { CallOptions, OperationId } from './contract';
import { DOMAINS, REPOSITORY_METHODS, type Domain, type Repositories } from './repositories';

/** One call through a repository: which operation, with what input. */
export interface Call {
  domain: Domain;
  method: string;
  operationId: OperationId;
  input: unknown;
  options: CallOptions | undefined;
}

export type Dispatcher = (call: Call) => Promise<unknown>;

/**
 * Builds every repository from one dispatcher. The http implementation routes by
 * operation ID; the mock bank can override whole domains on top.
 */
export function repositoriesFromDispatcher(
  dispatch: Dispatcher,
  overrides: Partial<Repositories> = {},
): Repositories {
  const entries = DOMAINS.map((domain) => {
    const override = overrides[domain];
    if (override) return [domain, override] as const;
    const methods = REPOSITORY_METHODS[domain] as Readonly<Record<string, OperationId>>;
    const repo = Object.fromEntries(
      Object.entries(methods).map(([method, operationId]) => [
        method,
        (input?: unknown, options?: CallOptions) =>
          dispatch({ domain, method, operationId, input, options }),
      ]),
    );
    return [domain, Object.freeze(repo)] as const;
  });
  // The tables in REPOSITORY_METHODS and the dispatcher are what make this sound.
  return Object.freeze(Object.fromEntries(entries)) as unknown as Repositories;
}
