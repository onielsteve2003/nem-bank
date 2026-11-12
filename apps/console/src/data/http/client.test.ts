import type { AuthSession } from '@nem/contracts';
import { describe, expect, it, vi } from 'vitest';

import { isApiError } from '../errors';
import { repositoriesFromDispatcher } from '../repositories';
import { createHttpDispatcher, DEVELOPER_SESSION_ENDED, type CustomerTokens } from './client';

const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type } });

function session(over: Partial<AuthSession> = {}): AuthSession {
  return {
    access_token: 'access-1',
    access_token_expires_at: new Date(Date.now() + 600_000).toISOString(),
    refresh_token: 'refresh-1',
    refresh_token_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    token_type: 'Bearer',
    ...over,
  } as AuthSession;
}

function setup(responses: Response[], customer: AuthSession | null = session()) {
  let current = customer;
  const tokens: CustomerTokens = {
    get: () => current,
    save: vi.fn((s: AuthSession) => {
      current = s;
    }),
    clear: vi.fn(() => {
      current = null;
    }),
  };
  const fetch = vi.fn(() => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return Promise.resolve(next);
  });
  const dispatch = createHttpDispatcher({
    baseUrl: 'https://api.test/',
    staffToken: () => 'staff-token',
    customer: tokens,
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { repos: repositoriesFromDispatcher(dispatch), fetch, tokens };
}

const lastCall = (fetch: ReturnType<typeof vi.fn>, n = 0) => {
  const [url, init] = fetch.mock.calls[n] as unknown as [string, RequestInit];
  return { url, init, headers: init.headers as Record<string, string> };
};

describe('console http dispatcher', () => {
  it('sends a staff call with the staff token, path and query', async () => {
    const { repos, fetch } = setup([json({ data: [], page: { next_cursor: null } })]);
    await repos.customers.search({ query: { q: 'ada', limit: 5 } });
    const { url, init, headers } = lastCall(fetch);
    expect(url).toBe('https://api.test/v1/admin/customers?q=ada&limit=5');
    expect(init.method).toBe('GET');
    expect(headers.Authorization).toBe('Bearer staff-token');
    expect(headers['X-Request-Id']).toBeTruthy();
  });

  it('sends the idempotency key and refuses a money call without one', async () => {
    const { repos, fetch } = setup([json({})]);
    const body = {} as never;
    await expect(
      repos.simulators.charge({ body } as unknown as Parameters<typeof repos.simulators.charge>[0]),
    ).rejects.toThrow('idempotencyKey');
    await repos.simulators.charge({ body, idempotencyKey: 'key-1' });
    expect(lastCall(fetch).headers['Idempotency-Key']).toBe('key-1');
  });

  it('sends the step-up token and a JSON body on a developer call', async () => {
    const { repos, fetch } = setup([json({ key: {}, secret: 'x' }, 201)]);
    await repos.developer.createKey({
      body: { name: 'Store', scopes: ['accounts_read'] },
      stepUpToken: 'stu_1',
    });
    const { headers, init } = lastCall(fetch);
    expect(headers.Authorization).toBe('Bearer access-1');
    expect(headers['X-Step-Up-Token']).toBe('stu_1');
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ name: 'Store', scopes: ['accounts_read'] }));
  });

  it('returns undefined for a 204', async () => {
    const { repos } = setup([new Response(null, { status: 204 })]);
    await expect(repos.developer.revokeKey({ path: { key_id: 'k1' } })).resolves.toBeUndefined();
  });

  it('keeps the problem the server sent', async () => {
    const { repos } = setup([
      json(
        { type: 'x', title: 'Not yours', status: 403, code: 'forbidden', request_id: 'r1' },
        403,
        'application/problem+json',
      ),
    ]);
    await expect(repos.dashboard.get({})).rejects.toSatisfy(
      (e) => isApiError(e, 'forbidden') && e.status === 403,
    );
  });

  it('turns a network failure into a 503 problem', async () => {
    const dispatch = createHttpDispatcher({
      baseUrl: 'https://api.test',
      staffToken: () => null,
      customer: { get: () => null, save: vi.fn(), clear: vi.fn() },
      fetch: (() => Promise.reject(new TypeError('failed'))) as unknown as typeof fetch,
    });
    await expect(repositoriesFromDispatcher(dispatch).dashboard.get({})).rejects.toSatisfy((e) =>
      isApiError(e, 'network_error'),
    );
  });

  it('refreshes a customer token that was rejected and retries once', async () => {
    const renewed = session({ access_token: 'access-2', refresh_token: 'refresh-2' });
    const { repos, fetch, tokens } = setup([
      json(
        { title: 'Sign in', status: 401, code: 'unauthorized' },
        401,
        'application/problem+json',
      ),
      json(renewed),
      json({ data: [] }),
    ]);
    await repos.developer.listKeys();
    expect(lastCall(fetch, 1).url).toBe('https://api.test/v1/auth/refresh');
    expect(JSON.parse(lastCall(fetch, 1).init.body as string)).toEqual({
      refresh_token: 'refresh-1',
    });
    expect(tokens.save).toHaveBeenCalledWith(renewed);
    expect(lastCall(fetch, 2).headers.Authorization).toBe('Bearer access-2');
  });

  it('shares one refresh between calls that need it at the same moment', async () => {
    const stale = session({ access_token_expires_at: new Date(Date.now() - 1000).toISOString() });
    const renewed = session({ access_token: 'access-2' });
    const { repos, fetch } = setup([json(renewed), json({ data: [] }), json({ data: [] })], stale);
    await Promise.all([repos.developer.listKeys(), repos.developer.listEndpoints()]);
    const refreshes = fetch.mock.calls.filter((call) =>
      String((call as unknown as [string])[0]).endsWith('/v1/auth/refresh'),
    );
    expect(refreshes).toHaveLength(1);
  });

  it('ends the developer session when the refresh token is refused', async () => {
    const { repos, tokens } = setup([
      json(
        { title: 'Sign in', status: 401, code: 'unauthorized' },
        401,
        'application/problem+json',
      ),
      json(
        { title: 'Sign in', status: 401, code: 'invalid_token' },
        401,
        'application/problem+json',
      ),
    ]);
    await expect(repos.developer.listKeys()).rejects.toSatisfy((e) =>
      isApiError(e, DEVELOPER_SESSION_ENDED),
    );
    expect(tokens.clear).toHaveBeenCalled();
  });

  it('does not ask a signed-out developer portal for anything', async () => {
    const { repos, fetch } = setup([], null);
    await expect(repos.developer.listKeys()).rejects.toSatisfy((e) =>
      isApiError(e, DEVELOPER_SESSION_ENDED),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
