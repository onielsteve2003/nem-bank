/**
 * Critical paths against a RUNNING Go API, through the app's own HTTP client and
 * repositories (T31.5). Not part of `pnpm test` or CI: it needs a server. Jest's Expo
 * preset swaps `fetch` for a native stub, so this runs under plain Node with the vitest
 * the console already installs.
 *
 *   cd apps/api && task db:up && go run ./cmd/api > api.log 2>&1
 *   cd apps/mobile
 *   E2E_API_URL=http://localhost:8080 E2E_API_LOG=../api/api.log  *     npx vitest run -c vitest.e2e.config.ts
 *
 * The API's log mailer writes sign-up codes to its log, which is how the test reads
 * them. Each run signs up fresh customers, so it can repeat against the same database.
 */
/// <reference types="node" />
import type { AuthSession } from '@nem/contracts';
import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { repositoriesFromDispatcher } from '../src/data/dispatch';
import { createSocketRealtime } from '../src/data/socketRealtime';
import {
  createHttpClient,
  type DeviceSigner,
  type RequestInput,
  type TokenStore,
} from '../src/data/http/client';

// The app signs with the same noble build (src/lib/deviceKey.ts), which that file keeps
// out of plain Node by importing Expo modules. The payload below is its signingPayload.
ed.hashes.sha512 = sha512;
const toBase64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const signingPayload = (r: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  body: string;
}) =>
  [
    r.method.toUpperCase(),
    r.path,
    r.timestamp,
    r.nonce,
    bytesToHex(sha256(utf8ToBytes(r.body))),
  ].join('\n');

const createHttpRepositories = (config: Parameters<typeof createHttpClient>[0]) => {
  const client = createHttpClient(config);
  return repositoriesFromDispatcher(({ operationId, input, options }) =>
    client.request(operationId, (input ?? {}) as RequestInput, options),
  );
};

const API = process.env.E2E_API_URL;
const LOG = process.env.E2E_API_LOG;
const live = API && LOG ? describe : describe.skip;

const PASSWORD = 'Correct-Horse-9!';
const PIN = '4827';
const stamp = Date.now().toString(36);
let counter = 0;
const naira = (major: number) => ({ amount_minor: String(major * 100), currency: 'NGN' as const });
const key = () => crypto.randomUUID();

/** The 6-digit code the log mailer wrote for this address. */
async function emailedCode(email: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const lines = readFileSync(LOG!, 'utf8').split('\n').reverse();
    for (const line of lines) {
      if (!line.includes('log mailer') || !line.includes(email)) continue;
      const text = (JSON.parse(line) as { text?: string }).text ?? '';
      const code = /\b(\d{6})\b/.exec(text)?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No code was emailed to ${email}`);
}

async function signUp(first: string) {
  const n = ++counter;
  const email = `${first.toLowerCase()}.${stamp}.${n}@example.com`;
  const phone = `+23480${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const secret = new Uint8Array(randomBytes(32));
  let session: AuthSession | null = null;
  let deviceId = '';
  const tokens: TokenStore = {
    get: () =>
      session && {
        accessToken: session.access_token,
        accessTokenExpiresAt: session.access_token_expires_at,
        refreshToken: session.refresh_token,
      },
    save: (s) => {
      session = s;
    },
    expire: () => {
      session = null;
    },
  };
  const signer: DeviceSigner = async (request) => ({
    deviceId,
    signature: toBase64Url(ed.sign(utf8ToBytes(signingPayload(request)), secret)),
  });
  const repos = createHttpRepositories({ baseUrl: API!, tokens, signer });

  const started = await repos.auth.startSignup({
    body: {
      first_name: first,
      last_name: 'Tester',
      email,
      phone,
      date_of_birth: '1994-03-21',
      consent: { terms_version: '1', privacy_version: '1', accepted_at: new Date().toISOString() },
    },
  });
  const verified = await repos.auth.verifyOtp({
    body: { challenge_id: started.otp.challenge_id, code: await emailedCode(email) },
  });
  session = await repos.auth.completeSignup({
    body: {
      signup_id: started.signup_id,
      verification_token: verified.verification_token,
      password: PASSWORD,
      pin: PIN,
      device: {
        name: `${first}'s test phone`,
        platform: 'android',
        public_key: toBase64Url(ed.getPublicKey(secret)),
        hardware_backed: false,
      },
    },
  });
  deviceId = session.device.id;
  const { data: accounts } = await repos.accounts.list({});
  const ngn = accounts.find((a) => a.currency === 'NGN')!;
  return { repos, email, user: session.user, ngn };
}

const balance = async (c: Awaited<ReturnType<typeof signUp>>, id = c.ngn.id) =>
  BigInt((await c.repos.accounts.get({ path: { account_id: id } })).ledger_balance.amount_minor);

live('live API: critical paths from the app', { timeout: 60_000 }, () => {
  let alice: Awaited<ReturnType<typeof signUp>>;
  let bob: Awaited<ReturnType<typeof signUp>>;

  it('onboards two customers, each with a naira account and a device', async () => {
    alice = await signUp('Alice');
    bob = await signUp('Bob');
    for (const c of [alice, bob]) {
      expect(c.user.is_demo).toBe(false);
      expect(c.ngn.receiving_details.scheme).toBe('nuban');
      expect(c.ngn.ledger_balance.amount_minor).toBe('0');
    }
    expect((await alice.repos.users.getMe({})).email).toBe(alice.email);
  });

  it('reaches Tier 2 with a sandbox BVN', async () => {
    const result = await alice.repos.kyc.verifyIdentity({
      body: {
        type: 'bvn',
        number: `2${String(Math.floor(Math.random() * 1e10)).padStart(10, '0')}`,
        date_of_birth: '1994-03-21',
      },
    });
    expect(result.verified).toBe(true);
    expect(result.tier).toBe(2);
  });

  it('is funded through the demo controls, which only demo users may use', async () => {
    // Nothing in the API makes a demo user or credits naira to a normal customer (the
    // /v1/auth/demo and most /v1/demo/* routes answer 501), so the harness flags Alice
    // in the database, the way a seeded demo persona would be.
    execFileSync('docker', [
      'exec',
      process.env.E2E_DB_CONTAINER ?? 'nem-bank-postgres-1',
      'psql',
      '-U',
      'nem',
      '-d',
      'nem',
      '-c',
      // Also 90 days old: the fraud model holds a brand-new account's first payment.
      `UPDATE users SET is_demo = true, created_at = now() - interval '90 days' WHERE email = '${alice.email}'`,
    ]);
    await alice.repos.demo.inboundTransfer({
      body: { account_id: alice.ngn.id, amount: naira(20_000), sender_name: 'E2E Employer' },
      idempotencyKey: key(),
    });
    // 20,000 less the 50 EMTL levied on inbound credits of 10,000 or more.
    expect(await balance(alice)).toBe(1_995_000n);
  });

  it('sends money to another customer, signed, and replays it without paying twice', async () => {
    const destination = {
      kind: 'nem' as const,
      account_number: (bob.ngn.receiving_details as { account_number: string }).account_number,
    };
    const idempotencyKey = key();
    const send = () =>
      alice.repos.transfers.create({
        body: {
          source_account_id: alice.ngn.id,
          destination,
          amount: naira(5_000),
          narration: 'e2e',
          save_beneficiary: false,
        },
        idempotencyKey,
      });
    const first = await send();
    expect(first.status, JSON.stringify(first.risk)).toBe('completed');

    const again = await send();
    expect(again.id).toBe(first.id);

    expect(await balance(alice)).toBe(1_995_000n - BigInt(first.total_debit.amount_minor));
    expect(await balance(bob)).toBe(500_000n);

    const history = await alice.repos.transactions.list({});
    expect(history.data.some((t) => t.amount.amount_minor === '500000')).toBe(true);
  });

  it('refuses a money call that is not signed by the bound device', async () => {
    const unsigned = createHttpRepositories({
      baseUrl: API!,
      tokens: {
        get: () => {
          throw new Error('unused');
        },
        save: () => undefined,
        expire: () => undefined,
      },
    });
    await expect(unsigned.transfers.list({})).rejects.toBeDefined();
  });

  it('issues a virtual card and freezes it', async () => {
    const card = await alice.repos.cards.create({
      body: { account_id: alice.ngn.id, type: 'standard', design: 'volt' },
      idempotencyKey: key(),
    });
    expect(card.status).toBe('active');
    await alice.repos.cards.freeze({ path: { card_id: card.id } });
    expect((await alice.repos.cards.get({ path: { card_id: card.id } })).status).toBe('frozen');
  });

  it('converts naira into a dollar wallet at a quoted rate', async () => {
    const usd = await alice.repos.accounts.open({
      body: { currency: 'USD' },
      idempotencyKey: key(),
    });
    const before = await balance(alice);
    const quote = await alice.repos.fx.createQuote({
      body: { from_account_id: alice.ngn.id, to_account_id: usd.id, sell_amount: naira(10_000) },
    });
    await alice.repos.fx.convert({ body: { quote_id: quote.quote_id }, idempotencyKey: key() });

    expect(await balance(alice, usd.id)).toBe(BigInt(quote.buy.amount_minor));
    expect(before - (await balance(alice))).toBe(
      BigInt(quote.sell.amount_minor) + BigInt(quote.fee.amount_minor),
    );
  });
  it('pushes a balance change to the app over the realtime socket', async () => {
    // Node's own WebSocket stands in for the phone's; the client code is the app's.
    const realtime = createSocketRealtime({
      getTicket: () => alice.repos.realtime.createTicket({}),
    });
    const types: string[] = [];
    const stop = realtime.subscribe((event) => types.push(event.type));
    realtime.setActive(true);
    await vi.waitFor(() => expect(realtime.status()).toBe('open'), { timeout: 10_000 });

    await alice.repos.demo.inboundTransfer({
      body: { account_id: alice.ngn.id, amount: naira(1_000), sender_name: 'E2E Friend' },
      idempotencyKey: key(),
    });
    await vi.waitFor(() => expect(types).toContain('account.balance_updated'), {
      timeout: 10_000,
    });
    stop();
    realtime.setActive(false);
  });
});
