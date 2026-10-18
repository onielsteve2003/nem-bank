import type { Transfer } from '@nem/contracts';
import { renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import {
  ApiError,
  createRepositories,
  DOMAINS,
  isApiError,
  REPOSITORY_METHODS,
  repositoriesFromDispatcher,
  RepositoryProvider,
  useRepository,
  type Call,
  type OperationInput,
  type OperationOutput,
  type TransfersRepo,
} from '../index';

describe('repository tables', () => {
  it('maps every operation ID to exactly one repository method', () => {
    const ids = DOMAINS.flatMap((d) => Object.values(REPOSITORY_METHODS[d]));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('repositoriesFromDispatcher', () => {
  it('routes calls with the domain, method, operation ID and input', async () => {
    const calls: Call[] = [];
    const repos = repositoriesFromDispatcher(async (call) => {
      calls.push(call);
      return { id: 't1' };
    });
    const signal = new AbortController().signal;
    await expect(repos.transfers.get({ path: { transfer_id: 't1' } }, { signal })).resolves.toEqual(
      { id: 't1' },
    );
    expect(calls).toEqual([
      {
        domain: 'transfers',
        method: 'get',
        operationId: 'getTransfer',
        input: { path: { transfer_id: 't1' } },
        options: { signal },
      },
    ]);
  });

  it('lets a whole domain be replaced', async () => {
    const listBanks = jest.fn().mockResolvedValue({ data: [] });
    const repos = repositoriesFromDispatcher(() => Promise.reject(new Error('unused')), {
      payees: { listBanks, resolve: jest.fn() },
    });
    await repos.payees.listBanks();
    expect(listBanks).toHaveBeenCalled();
  });
});

describe('createRepositories', () => {
  it('uses the mock bank by default', () => {
    const repos = createRepositories({ apiMode: 'mock', apiUrl: undefined });
    expect(typeof repos.accounts.list).toBe('function');
  });

  it('reports operations the http client cannot serve yet as problems', async () => {
    const repos = createRepositories({ apiMode: 'http', apiUrl: 'http://localhost:8080' });
    const error = await repos.accounts.list().catch((e: unknown) => e);
    expect(isApiError(error, 'not_implemented')).toBe(true);
    expect((error as ApiError).status).toBe(501);
  });

  it('uses http repositories in http mode', async () => {
    const repos = createRepositories({ apiMode: 'http', apiUrl: 'http://localhost:8080' });
    await expect(repos.accounts.list()).rejects.toThrow(/Phase 2/);
  });
});

describe('RepositoryProvider', () => {
  it('provides injected repositories to useRepository', async () => {
    const repositories = repositoriesFromDispatcher(() => Promise.resolve(undefined));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <RepositoryProvider repositories={repositories}>{children}</RepositoryProvider>
    );
    const { result } = await renderHook(() => useRepository('transfers'), { wrapper });
    expect(result.current).toBe(repositories.transfers);
  });

  it('throws a clear error outside the provider', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(renderHook(() => useRepository('cards'))).rejects.toThrow(/RepositoryProvider/);
  });
});

// Compile-time checks: the input and output types come from the contract.
export function typeChecks(transfers: TransfersRepo) {
  const output: OperationOutput<'getTransfer'> = {} as Transfer;
  const input: OperationInput<'createTransfer'> = {
    idempotencyKey: '0192',
    body: {} as OperationInput<'createTransfer'>['body'],
  };
  // @ts-expect-error money-moving calls need an idempotency key
  const missingKey: OperationInput<'createTransfer'> = { body: input.body };
  // @ts-expect-error path params are required
  void transfers.get({});
  void transfers.list();
  // 204 responses resolve to void.
  const deleted: Promise<void> = transfers.cancelScheduled({ path: { schedule_id: 's1' } });
  return { output, input, missingKey, deleted };
}
