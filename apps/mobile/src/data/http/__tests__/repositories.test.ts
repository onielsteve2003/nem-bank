import { isApiError } from '../../errors';
import { createHttpRepositories } from '..';

const BASE = 'https://api.test';
const tokens = {
  get: () => ({
    accessToken: 'a1',
    accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    refreshToken: 'r1',
  }),
  save: jest.fn(),
  expire: jest.fn(),
};

function setup(status = 200, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  return { repos: createHttpRepositories({ baseUrl: BASE, tokens, fetch }), calls };
}

describe('http repositories', () => {
  it('routes a repository call to its contract path with the bearer token', async () => {
    const { repos, calls } = setup(200, { items: [] });
    await repos.accounts.get({ path: { account_id: 'acc-1' } });
    expect(calls[0]!.url).toBe(`${BASE}/v1/accounts/acc-1`);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer a1');
  });

  it('turns an error response into the same ApiError the mock bank throws', async () => {
    const { repos } = setup(422, {
      type: 'about:blank',
      title: 'Limit reached',
      status: 422,
      code: 'limit_exceeded',
    });
    const error = await repos.accounts.list({}).catch((e: unknown) => e);
    expect(isApiError(error) && error.problem.code).toBe('limit_exceeded');
  });

  it('sends a photo as a multipart file part, not JSON', async () => {
    const { repos, calls } = setup(201, { id: 'doc-1' });
    await repos.kyc.uploadDocument({
      body: { kind: 'selfie', file: 'data:image/jpeg;base64,/9j/' },
    });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(calls[0]!.init.body).toBeInstanceOf(Uint8Array);
  });

  it('refuses a money call without an idempotency key', async () => {
    const { repos, calls } = setup();
    await expect(repos.transfers.create({ body: {} } as never, undefined)).rejects.toThrow(
      'idempotencyKey',
    );
    expect(calls).toHaveLength(0);
  });
});
