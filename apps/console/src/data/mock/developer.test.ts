import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';

import { isApiError } from '../errors';
import { repositoriesFromDispatcher } from '../repositories';
import { DEMO_DEVELOPER_PIN, developerStepUp } from './developer';
import { createMockDispatcher } from './index';
import { createMockState } from './state';

function setup() {
  const state = createMockState();
  const repos = repositoriesFromDispatcher(createMockDispatcher({ latencyMs: 0, state }));
  return { state, repos };
}

const is = (code: string) => (e: unknown) => isApiError(e, code);
const LIVE = '01900000-0000-7000-8000-0000000de101';
const STAGING = '01900000-0000-7000-8000-0000000de102';

describe('api keys', () => {
  it('returns the secret once and keeps only its hash', async () => {
    const { state, repos } = setup();
    const stepUpToken = developerStepUp(state, DEMO_DEVELOPER_PIN)!;
    const { key, secret } = await repos.developer.createKey({
      body: { name: 'Checkout', scopes: ['payment_links_write'] },
      stepUpToken,
    });
    expect(secret).toMatch(/^nem_test_[A-Za-z0-9]{32}$/);
    expect(key.prefix).toBe(secret.slice(0, 13));
    const stored = state.developer.keys.get(key.id)!;
    expect(stored.secretHash).toBe(bytesToHex(sha256(utf8ToBytes(secret))));
    expect(JSON.stringify(await repos.developer.listKeys())).not.toContain(secret);

    // The step-up token is good for one key only.
    await expect(
      repos.developer.createKey({
        body: { name: 'Again', scopes: ['accounts_read'] },
        stepUpToken,
      }),
    ).rejects.toSatisfy(is('step_up_required'));
  });

  it('refuses a wrong PIN and revokes a key', async () => {
    const { state, repos } = setup();
    expect(developerStepUp(state, '0000')).toBeNull();
    const id = '01900000-0000-7000-8000-0000000de001';
    await repos.developer.revokeKey({ path: { key_id: id } });
    expect(state.developer.keys.get(id)!.key.revoked_at).not.toBeNull();
  });
});

describe('webhooks', () => {
  it('only accepts https endpoints, and shows the signing secret once', async () => {
    const { repos } = setup();
    await expect(
      repos.developer.createEndpoint({
        body: { url: 'http://shop.example.com/hook', events: ['test.ping'] },
      }),
    ).rejects.toSatisfy(is('validation_failed'));
    const created = await repos.developer.createEndpoint({
      body: { url: 'https://shop.example.com/hook', events: ['test.ping'] },
    });
    expect(created.signing_secret).toMatch(/^whsec_[A-Za-z0-9]{32}$/);
    expect(created.endpoint.secret_prefix).toBe(created.signing_secret.slice(0, 10));
  });

  it('sends a test event and logs a failing receiver with backoff', async () => {
    const { repos } = setup();
    const ok = await repos.developer.sendTest({ path: { endpoint_id: LIVE } });
    expect(ok).toMatchObject({ status: 'succeeded', response_status: 200, attempt: 1 });

    const failing = await repos.developer.sendTest({ path: { endpoint_id: STAGING } });
    expect(failing).toMatchObject({ status: 'retrying', response_status: 500 });
    expect(Date.parse(failing.next_retry_at!) - Date.parse(failing.created_at)).toBe(60_000);
    const endpoint = await repos.developer.getEndpoint({ path: { endpoint_id: STAGING } });
    expect(endpoint.consecutive_failures).toBe(3);
  });

  it('replays with the same event ID, newest first in the log', async () => {
    const { repos } = setup();
    const { data } = await repos.developer.listDeliveries({ path: { endpoint_id: LIVE } });
    const replayed = await repos.developer.replay({ path: { delivery_id: data[0]!.id } });
    expect(replayed.event_id).toBe(data[0]!.event_id);
    expect(replayed.id).not.toBe(data[0]!.id);
    const after = await repos.developer.listDeliveries({ path: { endpoint_id: LIVE } });
    expect(after.data[0]!.id).toBe(replayed.id);
  });

  it('will not send to an endpoint that is off, and cancels retries on delete', async () => {
    const { state, repos } = setup();
    await repos.developer.updateEndpoint({
      path: { endpoint_id: LIVE },
      body: { status: 'disabled' },
    });
    await expect(repos.developer.sendTest({ path: { endpoint_id: LIVE } })).rejects.toSatisfy(
      is('endpoint_disabled'),
    );
    await repos.developer.deleteEndpoint({ path: { endpoint_id: STAGING } });
    expect(
      state.developer.deliveries.filter(
        (d) => d.endpoint_id === STAGING && d.status === 'retrying',
      ),
    ).toEqual([]);
  });

  it('rotates the signing secret', async () => {
    const { repos } = setup();
    const { endpoint, signing_secret } = await repos.developer.rotateSecret({
      path: { endpoint_id: LIVE },
    });
    expect(endpoint.secret_prefix).toBe(signing_secret.slice(0, 10));
    expect(endpoint.secret_prefix).not.toBe('whsec_3Fk9');
  });
});
