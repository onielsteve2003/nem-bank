// k6 load test: signed, idempotent internal transfers between demo customers.
//
// Every request is what the app sends: a bearer token, an Idempotency-Key and an Ed25519
// device signature over METHOD, target, timestamp, nonce and the body hash. k6's built-in
// WebCrypto signs with Ed25519, so no extension is needed. See loadtest/README.md.
//
//   BASE_URL      API address as the k6 process sees it   (default http://localhost:8080)
//   USERS         demo customers to create                (default 60)
//   RATE          transfers per second across all users   (default 25)
//   DURATION      steady load length                      (default 60s)

import { check } from 'k6';
import encoding from 'k6/encoding';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const USERS = Number(__ENV.USERS || 60);
const RATE = Number(__ENV.RATE || 25);
const DURATION = __ENV.DURATION || '60s';

const completed = new Counter('transfers_completed');
const replays = new Counter('transfer_replays_identical');
const transferLatency = new Trend('transfer_duration', true);

export const options = {
  // Each demo customer is built with six months of history, so setup is slow.
  setupTimeout: '600s',
  scenarios: {
    transfers: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    // The line the task asks for: p95 of a money-moving request.
    transfer_duration: ['p(95)<500', 'p(99)<1500'],
    // Every transfer must succeed: this run stays inside every limit on purpose.
    transfers_completed: ['count>0'],
    checks: ['rate>0.999'],
    http_req_failed: ['rate<0.001'],
  },
};

const b64url = (buf) => encoding.b64encode(buf, 'rawurl');
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

// A distinct client address per customer: the load test runs the API with
// CLIENT_IP_HEADER=X-Client-Ip, so the per-address demo sign-up limit does not apply to
// a test that makes sixty customers from one machine. Per-customer limits still do.
const headers = (extra) => Object.assign({ 'Content-Type': 'application/json' }, extra);

export async function setup() {
  const users = [];
  for (let i = 0; i < USERS; i++) {
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const publicKey = b64url(await crypto.subtle.exportKey('raw', pair.publicKey));
    const privateKey = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const ip = `10.77.${Math.floor(i / 250)}.${(i % 250) + 1}`;
    const res = http.post(
      `${BASE}/v1/auth/demo`,
      JSON.stringify({
        persona: 'tolu',
        device: { name: `load-${i}`, platform: 'android', public_key: publicKey },
      }),
      { headers: headers({ 'X-Client-Ip': ip }) },
    );
    if (res.status !== 201) throw new Error(`demo sign-in ${i}: ${res.status} ${res.body}`);
    const session = res.json();
    const accts = http.get(`${BASE}/v1/accounts`, {
      headers: headers({ Authorization: `Bearer ${session.access_token}`, 'X-Client-Ip': ip }),
    });
    const list = accts.json();
    const rows = Array.isArray(list) ? list : list.data;
    const ngn = rows.find((a) => a.currency === 'NGN');
    users.push({
      ip,
      token: session.access_token,
      deviceId: session.device.id,
      jwk: privateKey,
      accountId: ngn.id,
      accountNumber: ngn.receiving_details.account_number,
    });
  }
  return { users };
}

async function signedPost(user, path, bodyText, idempotencyKey) {
  const timestamp = new Date().toISOString();
  const nonce = uuidv4();
  const bodyHash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bodyText)));
  const payload = ['POST', path, timestamp, nonce, bodyHash].join('\n');
  const key = await crypto.subtle.importKey('jwk', user.jwk, { name: 'Ed25519' }, false, ['sign']);
  const signature = await crypto.subtle.sign('Ed25519', key, new TextEncoder().encode(payload));
  return http.post(`${BASE}${path}`, bodyText, {
    headers: headers({
      Authorization: `Bearer ${user.token}`,
      'Idempotency-Key': idempotencyKey,
      'X-Device-Id': user.deviceId,
      'X-Device-Signature': b64url(signature),
      'X-Signature-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Client-Ip': user.ip,
    }),
    tags: { name: 'POST /v1/transfers' },
  });
}

export default async function (data) {
  const n = data.users.length;
  const from = data.users[(__ITER + __VU) % n];
  const to = data.users[(__ITER + __VU + 1 + Math.floor(Math.random() * (n - 1))) % n];
  const body = JSON.stringify({
    source_account_id: from.accountId,
    destination: { kind: 'nem', account_number: to.accountNumber },
    amount: { amount_minor: '100', currency: 'NGN' }, // ₦1
    narration: 'k6',
    save_beneficiary: false,
  });
  const idempotencyKey = uuidv4();

  const res = await signedPost(from, '/v1/transfers', body, idempotencyKey);
  transferLatency.add(res.timings.duration);
  const ok = check(res, {
    'transfer created': (r) => r.status === 201 || r.status === 200,
    'transfer completed': (r) => r.json('status') === 'completed',
  });
  if (!ok) {
    console.error(`transfer failed: ${res.status} ${res.body}`);
    return;
  }
  completed.add(1);

  // One in twenty is sent again with the same key, as a phone does after a dropped
  // connection. The signature is fresh (a nonce is single use); the answer must be the same
  // transfer, and nothing may be paid twice.
  if (Math.random() < 0.05) {
    const again = await signedPost(from, '/v1/transfers', body, idempotencyKey);
    const same = check(again, { 'replay returns the same transfer': (r) => r.json('id') === res.json('id') });
    if (same) replays.add(1);
  }
}
