import {
  OPERATIONS,
  type AuthSession,
  type OperationId,
  type OperationMeta,
  type Problem,
  type RouteOperationId,
} from '@nem/contracts';

import { ApiError, problem } from '../errors';
import type { Dispatcher } from '../repositories';

// The console's transport for the Go API (T31.3). A repository call becomes one request
// through the contract's operation table. Two realms share it: staff operations carry the
// staff token (8 hours, no refresh), and the developer portal's operations carry a
// business customer's bearer token, refreshed once on a 401.

export interface RequestInput {
  path?: Record<string, string | number>;
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
  stepUpToken?: string;
}

/** Where the developer portal keeps its customer session. */
export interface CustomerTokens {
  get(): AuthSession | null;
  /** A refresh rotated the tokens. */
  save(session: AuthSession): void;
  /** The refresh token was rejected: the portal must sign in again. */
  clear(): void;
}

export interface HttpDispatcherConfig {
  baseUrl: string;
  /** The signed-in staff member's token, or null. */
  staffToken: () => string | null;
  customer: CustomerTokens;
  fetch?: typeof fetch;
}

const JSON_TYPES = /application\/(problem\+)?json/;

/** Raised for a customer-realm 401 so it is not mistaken for the staff session ending. */
export const DEVELOPER_SESSION_ENDED = 'developer_session_ended';

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

/** Keeps the server's problem when it sent one; any other failure becomes a generic problem. */
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
      // Not a problem document; fall through.
    }
  }
  return problem(response.status, 'http_error', response.statusText || 'Request failed', {
    request_id: requestId,
  });
}

const networkError = () =>
  problem(503, 'network_error', 'We could not reach Nem Bank', {
    detail: 'Check your connection and try again. The API may be waking up.',
  });

export function createHttpDispatcher(config: HttpDispatcherConfig): Dispatcher {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const doFetch = config.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  let refreshing: Promise<string> | null = null;

  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await doFetch(url, init);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw networkError();
    }
  }

  const ended = () =>
    problem(401, DEVELOPER_SESSION_ENDED, 'Your session has ended', {
      detail: 'Sign in again.',
    });

  /** One refresh at a time: a rotated refresh token spent twice would end the session. */
  function refresh(session: AuthSession): Promise<string> {
    refreshing ??= (async () => {
      const { method, path } = OPERATIONS.refreshSession;
      const response = await send(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      if (response.status === 401 || response.status === 403) {
        config.customer.clear();
        throw ended();
      }
      if (!response.ok) throw await toApiError(response);
      const next = (await response.json()) as AuthSession;
      config.customer.save(next);
      return next.access_token;
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  function customerToken(): Promise<string> | string {
    const session = config.customer.get();
    if (!session) throw ended();
    // Refresh a little early so a call never leaves with a token that dies on the way.
    return Date.parse(session.access_token_expires_at) - 30_000 > Date.now()
      ? session.access_token
      : refresh(session);
  }

  return async ({ operationId, input, options }) => {
    const meta: OperationMeta | undefined = OPERATIONS[operationId as RouteOperationId];
    if (!meta) throw new TypeError(`${operationId as OperationId} is not an API route`);
    if (meta.auth === 'apiKey')
      throw new TypeError(`${operationId} is for API keys, not the console`);
    const { path, query, body, idempotencyKey, stepUpToken } = (input ?? {}) as RequestInput;
    const target = buildPath(meta.path, path) + buildQuery(query);
    const text = body === undefined ? '' : JSON.stringify(body);

    const attempt = async (token: string | null) => {
      const headers: Record<string, string> = {
        Accept: 'application/json, application/problem+json',
        'X-Request-Id': crypto.randomUUID(),
      };
      if (text) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = `Bearer ${token}`;
      if (meta.idempotent) {
        // A key made up here would change on every retry and defeat the point.
        if (!idempotencyKey) throw new TypeError('Money-moving calls need an idempotencyKey');
        headers['Idempotency-Key'] = idempotencyKey;
      }
      if (stepUpToken) headers['X-Step-Up-Token'] = stepUpToken;
      return send(`${baseUrl}${target}`, {
        method: meta.method,
        headers,
        body: text || undefined,
        signal: options?.signal,
      });
    };

    const realm = meta.auth;
    let response = await attempt(
      realm === 'staff' ? config.staffToken() : realm === 'bearer' ? await customerToken() : null,
    );
    if (response.status === 401 && realm === 'bearer') {
      const session = config.customer.get();
      if (!session) throw ended();
      response = await attempt(await refresh(session));
      if (response.status === 401) {
        config.customer.clear();
        throw ended();
      }
    }
    if (!response.ok) throw await toApiError(response);
    if (response.status === 204) return undefined;
    return response.json();
  };
}
