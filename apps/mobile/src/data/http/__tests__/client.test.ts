import type { AuthSession } from '@nem/contracts';

import { isApiError } from '../../errors';
import { buildPath, buildQuery, createHttpClient, type TokenStore, type Tokens } from '../client';

const BASE = 'https://api.test';
const NOW = Date.parse('2026-10-18T12:00:00Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const now = () => NOW;

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function reply({ status, body, headers = {} }: Reply): Response {
  const type = status >= 400 ? 'application/problem+json' : 'application/json';
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': type, ...headers },
  });
}

/** Answers requests in order and records what was sent. */
function fakeFetch(...replies: Reply[]) {
  const sent: Sent[] = [];
  const fetch = jest.fn(async (url: string, init: RequestInit) => {
    sent.push({
      url,
      method: init.method!,
      headers: init.headers as Record<string, string>,
      body: init.body as string | undefined,
    });
    const next = replies.shift();
    if (!next) throw new Error(`Unexpected request ${url}`);
    return reply(next);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
}

function tokenStore(initial: Tokens | null) {
  let current = initial;
  const store = {
    get: () => current,
    save: jest.fn((s: AuthSession) => {
      current = {
        accessToken: s.access_token,
        accessTokenExpiresAt: s.access_token_expires_at,
        refreshToken: s.refresh_token,
      };
    }),
    expire: jest.fn(() => {
      current = null;
    }),
  } satisfies TokenStore;
  return store;
}

const fresh: Tokens = { accessToken: 'a1', accessTokenExpiresAt: iso(600_000), refreshToken: 'r1' };
const rotated = {
  access_token: 'a2',
  access_token_expires_at: iso(600_000),
  refresh_token: 'r2',
  refresh_token_expires_at: iso(86_400_000),
  token_type: 'Bearer',
};
const unauthorized = {
  type: 'about:blank',
  title: 'Unauthorized',
  status: 401,
  code: 'unauthorized',
};

describe('url building', () => {
  it('fills and encodes path parameters', () => {
    expect(buildPath('/v1/transfers/{transfer_id}', { transfer_id: 'a/b c' })).toBe(
      '/v1/transfers/a%2Fb%20c',
    );
    expect(() => buildPath('/v1/x/{id}', {})).toThrow('Missing path parameter "id"');
  });

  it('skips empty query values and repeats arrays', () => {
    expect(buildQuery({ limit: 20, cursor: undefined, status: ['a', 'b'], q: null })).toBe(
      '?limit=20&status=a&status=b',
    );
    expect(buildQuery({})).toBe('');
  });
});

describe('http client', () => {
  it('sends the bearer token and a request ID, and returns the JSON body', async () => {
    const { fetch, sent } = fakeFetch({ status: 200, body: { id: 'u1' } });
    const client = createHttpClient({
      baseUrl: `${BASE}/`,
      fetch,
      tokens: tokenStore(fresh),
      now,
    });

    await expect(client.request('getMe')).resolves.toEqual({ id: 'u1' });
    expect(sent[0]).toMatchObject({ url: `${BASE}/v1/users/me`, method: 'GET' });
    expect(sent[0]!.headers.Authorization).toBe('Bearer a1');
    expect(sent[0]!.headers['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends no token on public operations', async () => {
    const { fetch, sent } = fakeFetch({ status: 200, body: rotated });
    const client = createHttpClient({ baseUrl: BASE, fetch, now });
    await client.request('login', { body: { identifier: 'x', password: 'y' } });
    expect(sent[0]!.headers.Authorization).toBeUndefined();
    expect(sent[0]!.headers['Content-Type']).toBe('application/json');
  });

  it('refreshes a stale token once for concurrent requests', async () => {
    const tokens = tokenStore({ ...fresh, accessTokenExpiresAt: iso(10_000) });
    const { fetch, sent } = fakeFetch(
      { status: 200, body: rotated },
      { status: 200, body: {} },
      { status: 200, body: {} },
    );
    const client = createHttpClient({ baseUrl: BASE, fetch, tokens, now });

    await Promise.all([client.request('getMe'), client.request('listAccounts')]);
    expect(sent.filter((s) => s.url.endsWith('/v1/auth/refresh'))).toHaveLength(1);
    expect(JSON.parse(sent[0]!.body!)).toEqual({ refresh_token: 'r1' });
    expect(tokens.save).toHaveBeenCalledTimes(1);
    expect(sent.slice(1).map((s) => s.headers.Authorization)).toEqual(['Bearer a2', 'Bearer a2']);
  });

  it('retries once with a new token when the API answers 401', async () => {
    const { fetch, sent } = fakeFetch(
      { status: 401, body: unauthorized },
      { status: 200, body: rotated },
      { status: 200, body: { id: 'u1' } },
    );
    const client = createHttpClient({ baseUrl: BASE, fetch, tokens: tokenStore(fresh), now });

    await expect(client.request('getMe')).resolves.toEqual({ id: 'u1' });
    expect(sent.map((s) => s.headers.Authorization ?? 'refresh')).toEqual([
      'Bearer a1',
      'refresh',
      'Bearer a2',
    ]);
  });

  it('ends the session when the refresh token is rejected', async () => {
    const tokens = tokenStore({ ...fresh, accessTokenExpiresAt: iso(0) });
    const { fetch } = fakeFetch({ status: 401, body: unauthorized });
    const client = createHttpClient({ baseUrl: BASE, fetch, tokens, now });

    const error = await client.request('getMe').catch((e: unknown) => e);
    expect(isApiError(error, 'session_expired')).toBe(true);
    expect(tokens.expire).toHaveBeenCalled();
  });

  it('adds the idempotency key, step-up token and device signature to money calls', async () => {
    const { fetch, sent } = fakeFetch({ status: 201, body: { id: 't1' } });
    const signer = jest.fn(async () => ({ deviceId: 'd1', signature: 'sig' }));
    const client = createHttpClient({
      baseUrl: BASE,
      fetch,
      tokens: tokenStore(fresh),
      signer,
      now,
    });
    const body = { amount: { amount_minor: '150000', currency: 'NGN' } };

    await client.request('createTransfer', { body, idempotencyKey: 'key-1', stepUpToken: 'su-1' });
    const headers = sent[0]!.headers;
    expect(headers).toMatchObject({
      'Idempotency-Key': 'key-1',
      'X-Step-Up-Token': 'su-1',
      'X-Device-Id': 'd1',
      'X-Device-Signature': 'sig',
      'X-Signature-Timestamp': iso(0),
    });
    expect(headers['X-Nonce']).toMatch(/^[0-9a-f]{32}$/);
    expect(signer).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/transfers',
      timestamp: iso(0),
      nonce: headers['X-Nonce'],
      body: JSON.stringify(body),
    });
  });

  it('refuses a money call without an idempotency key or a device signer', async () => {
    const { fetch } = fakeFetch();
    const client = createHttpClient({ baseUrl: BASE, fetch, tokens: tokenStore(fresh), now });

    await expect(client.request('createTransfer', { body: {} })).rejects.toThrow('idempotencyKey');
    const error = await client
      .request('createTransfer', { body: {}, idempotencyKey: 'k' })
      .catch((e: unknown) => e);
    expect(isApiError(error, 'device_not_bound')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps problem+json to ApiError and keeps the request ID', async () => {
    const { fetch } = fakeFetch({
      status: 422,
      headers: { 'X-Request-Id': 'req-9' },
      body: { title: 'Not enough money', status: 422, code: 'insufficient_funds' },
    });
    const client = createHttpClient({ baseUrl: BASE, fetch, tokens: tokenStore(fresh), now });

    const error = await client.request('getMe').catch((e: unknown) => e);
    expect(isApiError(error, 'insufficient_funds')).toBe(true);
    expect(isApiError(error) && error.problem.request_id).toBe('req-9');
  });

  it('maps a non-problem failure and a network failure to stable codes', async () => {
    const html = jest.fn(
      async () => new Response('<html>', { status: 502, statusText: 'Bad Gateway' }),
    );
    const client = createHttpClient({
      baseUrl: BASE,
      fetch: html as unknown as typeof fetch,
      tokens: tokenStore(fresh),
      now,
    });
    const bad = await client.request('getMe').catch((e: unknown) => e);
    expect(isApiError(bad, 'http_error') && bad.status).toBe(502);

    const down = createHttpClient({
      baseUrl: BASE,
      fetch: jest.fn(async () => {
        throw new TypeError('Network request failed');
      }) as unknown as typeof fetch,
      tokens: tokenStore(fresh),
      now,
    });
    const offline = await down.request('getMe').catch((e: unknown) => e);
    expect(isApiError(offline, 'network_error') && offline.status).toBe(503);
  });

  it('returns undefined for 204', async () => {
    const empty = jest.fn(async () => new Response(null, { status: 204 }));
    const client = createHttpClient({
      baseUrl: BASE,
      fetch: empty as unknown as typeof fetch,
      tokens: tokenStore(fresh),
      now,
    });
    await expect(
      client.request('logout', { body: { refresh_token: 'r1' } }),
    ).resolves.toBeUndefined();
  });

  it('rejects operation IDs that are not routes', async () => {
    const client = createHttpClient({ baseUrl: BASE, fetch: fakeFetch().fetch, now });
    await expect(client.request('onTransferCompleted')).rejects.toThrow('not an API route');
  });
});
