import {
  OPERATIONS,
  type AuthSession,
  type OperationMeta,
  type Problem,
  type RouteOperationId,
} from '@nem/contracts';

import { uuidv7 } from '@/lib/ids';

import type { CallOptions, OperationId } from '../contract';
import { ApiError, problem } from '../errors';

// The transport for Phase 2 (architecture §6). It turns a repository call into an
// HTTP request using the contract's operation table and adds what the caller
// never chooses: the bearer token (refreshed when stale or rejected), a request
// ID, the idempotency key and step-up token from the input, and the device
// signature on money-moving calls. Every failure becomes an ApiError.

/** What a repository passes in; `path`, `query` and `body` follow the contract. */
export interface RequestInput {
  path?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
  stepUpToken?: string;
}

export interface Tokens {
  accessToken: string;
  /** RFC 3339; the client refreshes ahead of it. */
  accessTokenExpiresAt: string;
  refreshToken: string;
}

/** Where the client reads and stores tokens; the session store in the app. */
export interface TokenStore {
  get(): Tokens | null;
  /** A refresh rotated the tokens. */
  save(session: AuthSession): void;
  /** The refresh token was rejected: the user must sign in again. */
  expire(): void;
}

/** What the device key signs: `METHOD\npath\ntimestamp\nnonce\nsha256(body)`. */
export interface SigningRequest {
  method: string;
  /** Path with query string, exactly as sent. */
  path: string;
  timestamp: string;
  nonce: string;
  /** The exact body bytes sent ("" when there is none). */
  body: string;
}

export interface DeviceSignature {
  deviceId: string;
  /** Base64url Ed25519 signature. */
  signature: string;
}

/** Signs after PIN or biometric unlock (device keys, M14). */
export type DeviceSigner = (request: SigningRequest) => Promise<DeviceSignature>;

export interface HttpClientConfig {
  baseUrl: string;
  tokens?: TokenStore;
  signer?: DeviceSigner;
  fetch?: typeof fetch;
  /** Refresh this long before the access token expires. */
  refreshSkewMs?: number;
  now?: () => number;
}

export interface HttpClient {
  request<T = unknown>(
    operationId: OperationId,
    input?: RequestInput,
    options?: CallOptions,
  ): Promise<T>;
}

const JSON_TYPES = /application\/(problem\+)?json/;

export function buildPath(template: string, params: RequestInput['path'] = {}): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined)
      throw new TypeError(`Missing path parameter "${name}" for ${template}`);
    return encodeURIComponent(String(value));
  });
}

export function buildQuery(query: RequestInput['query'] = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    for (const item of Array.isArray(value) ? value : [value]) search.append(key, String(item));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function nonce(): string {
  return uuidv7().replace(/-/g, '');
}

/** Turns any non-2xx response into an ApiError, keeping the server's problem when there is one. */
export async function toApiError(response: Response): Promise<ApiError> {
  const requestId = response.headers.get('X-Request-Id') ?? undefined;
  if (JSON_TYPES.test(response.headers.get('Content-Type') ?? '')) {
    try {
      const body = (await response.json()) as Partial<Problem>;
      if (typeof body.code === 'string' && typeof body.title === 'string') {
        return new ApiError({
          type: 'about:blank',
          ...body,
          status: body.status ?? response.status,
          request_id: body.request_id ?? requestId,
        } as Problem);
      }
    } catch {
      // Not a problem document; fall through to a generic one.
    }
  }
  return problem(response.status, 'http_error', response.statusText || 'Request failed', {
    request_id: requestId,
  });
}

const networkError = () =>
  problem(503, 'network_error', 'We could not reach Nem Bank', {
    detail: 'Check your connection and try again.',
  });

const sessionExpired = () =>
  problem(401, 'session_expired', 'Your session has ended', { detail: 'Sign in again.' });

export function createHttpClient(config: HttpClientConfig): HttpClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const doFetch = config.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = config.now ?? Date.now;
  const skew = config.refreshSkewMs ?? 30_000;
  let refreshing: Promise<string> | null = null;

  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, init);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw networkError();
    }
  }

  /** One refresh at a time: concurrent requests wait for the same new token. */
  function refresh(tokens: Tokens): Promise<string> {
    refreshing ??= (async () => {
      const { method, path } = OPERATIONS.refreshSession;
      const response = await send(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Request-Id': uuidv7(),
        },
        body: JSON.stringify({ refresh_token: tokens.refreshToken }),
      });
      if (response.status === 401 || response.status === 403) {
        config.tokens?.expire();
        throw sessionExpired();
      }
      if (!response.ok) throw await toApiError(response);
      const session = (await response.json()) as AuthSession;
      config.tokens?.save(session);
      return session.access_token;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function accessToken(): Promise<string> {
    const tokens = config.tokens?.get();
    if (!tokens) throw sessionExpired();
    if (Date.parse(tokens.accessTokenExpiresAt) - skew > now()) return tokens.accessToken;
    return refresh(tokens);
  }

  async function headersFor(
    meta: OperationMeta,
    input: RequestInput,
    target: string,
    body: string,
    token: string | null,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: 'application/json, application/problem+json',
      'X-Request-Id': uuidv7(),
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (meta.idempotent) {
      // A key made up here would differ on every retry and defeat the point.
      if (!input.idempotencyKey) throw new TypeError('Money-moving calls need an idempotencyKey');
      headers['Idempotency-Key'] = input.idempotencyKey;
    }
    if (input.stepUpToken) headers['X-Step-Up-Token'] = input.stepUpToken;
    if (meta.signed) {
      if (!config.signer) {
        throw problem(400, 'device_not_bound', 'This device cannot sign payments yet', {
          detail: 'Set up this device in Security before moving money.',
        });
      }
      const timestamp = new Date(now()).toISOString();
      const signing: SigningRequest = {
        method: meta.method,
        path: target,
        timestamp,
        nonce: nonce(),
        body,
      };
      const { deviceId, signature } = await config.signer(signing);
      headers['X-Device-Id'] = deviceId;
      headers['X-Device-Signature'] = signature;
      headers['X-Signature-Timestamp'] = signing.timestamp;
      headers['X-Nonce'] = signing.nonce;
    }
    return headers;
  }

  return {
    async request<T>(
      operationId: OperationId,
      input: RequestInput = {},
      options: CallOptions = {},
    ) {
      const meta: OperationMeta | undefined = OPERATIONS[operationId as RouteOperationId];
      if (!meta) throw new TypeError(`${operationId} is not an API route`);
      const target = buildPath(meta.path, input.path) + buildQuery(input.query);
      const body = input.body === undefined ? '' : JSON.stringify(input.body);
      const bearer = meta.auth === 'bearer';

      const attempt = async (token: string | null) =>
        send(`${baseUrl}${target}`, {
          method: meta.method,
          headers: await headersFor(meta, input, target, body, token),
          body: body || undefined,
          signal: options.signal,
        });

      let response = await attempt(bearer ? await accessToken() : null);
      // A token revoked or expired early: refresh once and try again. The retry is
      // safe for money calls because it carries the same idempotency key.
      if (response.status === 401 && bearer && config.tokens?.get()) {
        response = await attempt(await refresh(config.tokens.get()!));
      }
      if (!response.ok) throw await toApiError(response);
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    },
  };
}
