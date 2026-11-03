import type { Schema } from '@nem/contracts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { problem } from '../errors';
import type { Handlers } from './handlers';
import { paginate } from './paging';
import { newId, type MockState } from './state';

// The developer platform for business customers (DEV-1 to DEV-3), as Dayo's store sees
// it in the sandbox. Secrets are returned once and kept only as SHA-256 hashes.

type ApiKey = Schema<'ApiKey'>;
type Endpoint = Schema<'WebhookEndpoint'>;
type Delivery = Schema<'WebhookDelivery'>;
type EventType = Schema<'WebhookEventType'>;

export interface DeveloperState {
  keys: Map<string, { key: ApiKey; secretHash: string }>;
  endpoints: Map<string, { endpoint: Endpoint; secretHash: string }>;
  /** Oldest first. */
  deliveries: Delivery[];
  /** Step-up tokens issued by the demo PIN check, each good for one key. */
  stepUpTokens: Set<string>;
}

/** The demo business account's PIN, shown on the page: it's a public sandbox. */
export const DEMO_DEVELOPER_PIN = '2468';

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomToken(length = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => BASE62[b % 62]).join('');
}

const hash = (secret: string) => bytesToHex(sha256(utf8ToBytes(secret)));

/** Retries back off 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h (WebhookDelivery.attempt). */
const BACKOFF_MS = [60, 300, 1_800, 7_200, 21_600, 43_200, 86_400].map((s) => s * 1_000);

const iso = (ms: number) => new Date(ms).toISOString();

type WebhookEvent = Schema<'WebhookEvent'>;
/** Sandbox events carry a small summary object; the API sends the full resource. */ function event(
  type: EventType,
  at: string,
  object: Record<string, unknown>,
): WebhookEvent {
  const data = { object: object as WebhookEvent['data']['object'] };
  return { id: newId(), type, created_at: at, livemode: false, data };
}

/** The sandbox receiver: a URL with "fail" in it answers 500, anything else 200. */
function attempt(endpoint: Endpoint, body: WebhookEvent, attemptNo: number, now: number): Delivery {
  const fails = endpoint.url.includes('fail');
  const retryable = fails && attemptNo < 8;
  return {
    id: newId(),
    endpoint_id: endpoint.id,
    event_id: body.id,
    event_type: body.type,
    attempt: attemptNo,
    status: fails ? (retryable ? 'retrying' : 'failed') : 'succeeded',
    response_status: fails ? 500 : 200,
    response_body_excerpt: fails ? '{"error":"internal server error"}' : '{"received":true}',
    duration_ms: fails ? 1_840 : 120 + (body.id.charCodeAt(0) % 200),
    request_body: body,
    next_retry_at: retryable ? iso(now + BACKOFF_MS[attemptNo - 1]!) : null,
    created_at: iso(now),
  };
}

export function seedDeveloper(now: number): DeveloperState {
  const day = 86_400_000;
  const keys: ApiKey[] = [
    {
      id: '01900000-0000-7000-8000-0000000de001',
      name: 'Store backend',
      prefix: 'nem_test_7Hq2',
      scopes: ['accounts_read', 'transactions_read', 'payment_links_write'],
      environment: 'sandbox',
      created_at: iso(now - 20 * day),
      last_used_at: iso(now - 3_600_000),
      revoked_at: null,
    },
    {
      id: '01900000-0000-7000-8000-0000000de002',
      name: 'Old laptop script',
      prefix: 'nem_test_Lk9w',
      scopes: ['transactions_read'],
      environment: 'sandbox',
      created_at: iso(now - 40 * day),
      last_used_at: iso(now - 25 * day),
      revoked_at: iso(now - 24 * day),
    },
  ];
  const live: Endpoint = {
    id: '01900000-0000-7000-8000-0000000de101',
    url: 'https://dayo-store.example.com/webhooks/nem',
    description: 'Order fulfilment',
    events: ['payment_link.paid', 'transfer.completed', 'transfer.failed'],
    status: 'active',
    secret_prefix: 'whsec_3Fk9',
    consecutive_failures: 0,
    created_at: iso(now - 18 * day),
  };
  const flaky: Endpoint = {
    id: '01900000-0000-7000-8000-0000000de102',
    url: 'https://staging.dayo-store.example.com/fail/webhooks',
    description: 'Staging (returns 500)',
    events: ['payment_link.paid', 'test.ping'],
    status: 'active',
    secret_prefix: 'whsec_Qm2x',
    consecutive_failures: 2,
    created_at: iso(now - 2 * day),
  };

  const deliveries: Delivery[] = [];
  const paid = (minutesAgo: number, reference: string, naira: number) => {
    const at = now - minutesAgo * 60_000;
    const body = event('payment_link.paid', iso(at), {
      object: 'payment_link',
      reference,
      amount: { amount_minor: String(naira * 100), currency: 'NGN' },
    });
    deliveries.push(attempt(live, body, 1, at));
    return body;
  };
  paid(2_900, 'PL-1042', 18_500);
  paid(1_400, 'PL-1043', 7_200);
  paid(95, 'PL-1044', 42_000);
  // The same payment fanned out to staging, which keeps failing and backing off.
  const body = paid(40, 'PL-1045', 9_900);
  const stagingBody = { ...body, id: newId() };
  deliveries.push(attempt(flaky, stagingBody, 1, now - 40 * 60_000));
  deliveries.push(attempt(flaky, stagingBody, 2, now - 39 * 60_000));

  return {
    keys: new Map(keys.map((k) => [k.id, { key: k, secretHash: hash(randomToken()) }])),
    endpoints: new Map(
      [live, flaky].map((e) => [e.id, { endpoint: e, secretHash: hash(randomToken()) }]),
    ),
    deliveries,
    stepUpTokens: new Set(),
  };
}

/** Demo stand-in for POST /v1/auth/step-up + verify with method `pin`. */
export function developerStepUp(state: MockState, pin: string): string | null {
  if (pin !== DEMO_DEVELOPER_PIN) return null;
  const token = `stu_${randomToken(24)}`;
  state.developer.stepUpTokens.add(token);
  return token;
}

function invalid(field: string, title: string, message: string): never {
  throw problem(422, 'validation_failed', title, { errors: [{ field, code: 'invalid', message }] });
}

function findEndpoint(state: MockState, id: string) {
  const found = state.developer.endpoints.get(id);
  if (!found) throw problem(404, 'not_found', 'No webhook endpoint with that ID');
  return found;
}

function checkUrl(url: string) {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (parsed?.protocol !== 'https:' || url.length > 500) {
    invalid('/url', 'Use an https:// URL', 'Webhooks are only sent over HTTPS.');
  }
}

function checkEvents(events: readonly EventType[]) {
  if (events.length === 0) invalid('/events', 'Pick at least one event', 'Choose one or more.');
}

function newSecret(prefix: 'nem_test_' | 'whsec_') {
  const secret = `${prefix}${randomToken()}`;
  return { secret, prefix: secret.slice(0, prefix.length + 4), secretHash: hash(secret) };
}

function send(state: MockState, endpoint: Endpoint, body: WebhookEvent) {
  const delivery = attempt(endpoint, body, 1, state.now());
  state.developer.deliveries.push(delivery);
  endpoint.consecutive_failures =
    delivery.status === 'succeeded' ? 0 : endpoint.consecutive_failures + 1;
  return delivery;
}

export const developerHandlers: Handlers = {
  listApiKeys: (_input, { state }) => ({
    data: structuredClone(
      [...state.developer.keys.values()]
        .map((k) => k.key)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    ),
  }),

  createApiKey: ({ body, stepUpToken }, { state }) => {
    if (!state.developer.stepUpTokens.delete(stepUpToken)) {
      throw problem(403, 'step_up_required', 'Confirm it is you first', {
        detail: 'Creating a key needs your PIN again.',
      });
    }
    const name = body.name.trim();
    if (!name || name.length > 40) invalid('/name', 'Name the key', '1 to 40 characters.');
    if (body.scopes.length === 0)
      invalid('/scopes', 'Pick at least one scope', 'Choose one or more.');
    const { secret, prefix, secretHash } = newSecret('nem_test_');
    const key: ApiKey = {
      id: newId(),
      name,
      prefix,
      scopes: [...new Set(body.scopes)],
      environment: 'sandbox',
      created_at: iso(state.now()),
      last_used_at: null,
      revoked_at: null,
    };
    state.developer.keys.set(key.id, { key, secretHash });
    return { key: structuredClone(key), secret };
  },

  revokeApiKey: ({ path }, { state }) => {
    const found = state.developer.keys.get(path.key_id);
    if (!found) throw problem(404, 'not_found', 'No API key with that ID');
    found.key.revoked_at ??= iso(state.now());
    return undefined;
  },

  listWebhookEndpoints: (_input, { state }) => ({
    data: structuredClone(
      [...state.developer.endpoints.values()]
        .map((e) => e.endpoint)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    ),
  }),

  createWebhookEndpoint: ({ body }, { state }) => {
    checkUrl(body.url);
    checkEvents(body.events);
    const { secret, prefix, secretHash } = newSecret('whsec_');
    const endpoint: Endpoint = {
      id: newId(),
      url: body.url,
      description: body.description?.trim() || null,
      events: [...new Set(body.events)],
      status: 'active',
      secret_prefix: prefix,
      consecutive_failures: 0,
      created_at: iso(state.now()),
    };
    state.developer.endpoints.set(endpoint.id, { endpoint, secretHash });
    return { endpoint: structuredClone(endpoint), signing_secret: secret };
  },

  getWebhookEndpoint: ({ path }, { state }) =>
    structuredClone(findEndpoint(state, path.endpoint_id).endpoint),

  updateWebhookEndpoint: ({ path, body }, { state }) => {
    const { endpoint } = findEndpoint(state, path.endpoint_id);
    if (body.url !== undefined) checkUrl(body.url);
    if (body.events !== undefined) checkEvents(body.events);
    Object.assign(endpoint, {
      ...(body.url !== undefined && { url: body.url }),
      ...(body.description !== undefined && { description: body.description?.trim() || null }),
      ...(body.events !== undefined && { events: [...new Set(body.events)] }),
      ...(body.status !== undefined && { status: body.status }),
    });
    // Turning it back on starts the failure count again.
    if (body.status === 'active') endpoint.consecutive_failures = 0;
    return structuredClone(endpoint);
  },

  deleteWebhookEndpoint: ({ path }, { state }) => {
    findEndpoint(state, path.endpoint_id);
    state.developer.endpoints.delete(path.endpoint_id);
    for (const d of state.developer.deliveries) {
      if (d.endpoint_id === path.endpoint_id && d.status === 'retrying') {
        Object.assign(d, { status: 'failed', next_retry_at: null });
      }
    }
    return undefined;
  },

  rotateWebhookSecret: ({ path }, { state }) => {
    const found = findEndpoint(state, path.endpoint_id);
    const { secret, prefix, secretHash } = newSecret('whsec_');
    found.secretHash = secretHash;
    found.endpoint.secret_prefix = prefix;
    return { endpoint: structuredClone(found.endpoint), signing_secret: secret };
  },

  sendTestWebhook: ({ path }, { state }) => {
    const { endpoint } = findEndpoint(state, path.endpoint_id);
    if (endpoint.status === 'disabled') {
      throw problem(409, 'endpoint_disabled', 'Turn this endpoint on to send to it');
    }
    const body = event('test.ping', iso(state.now()), {
      object: 'test',
      message: 'Hello from Nem',
    });
    return structuredClone(send(state, endpoint, body));
  },

  listWebhookDeliveries: ({ path, query }, { state }) => {
    findEndpoint(state, path.endpoint_id);
    const rows = state.developer.deliveries
      .filter(
        (d) => d.endpoint_id === path.endpoint_id && (!query?.status || d.status === query.status),
      )
      .reverse();
    return paginate(structuredClone(rows), query?.cursor, query?.limit);
  },

  replayWebhookDelivery: ({ path }, { state }) => {
    const original = state.developer.deliveries.find((d) => d.id === path.delivery_id);
    if (!original?.request_body) throw problem(404, 'not_found', 'No delivery with that ID');
    const { endpoint } = findEndpoint(state, original.endpoint_id);
    if (endpoint.status === 'disabled') {
      throw problem(409, 'endpoint_disabled', 'Turn this endpoint on to send to it');
    }
    // The same event ID, so the receiver can tell it already has it.
    return structuredClone(send(state, endpoint, original.request_body as WebhookEvent));
  },
};
