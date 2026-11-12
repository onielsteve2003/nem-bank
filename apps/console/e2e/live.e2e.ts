/**
 * The console's critical paths against a RUNNING Go API, through its own http
 * dispatcher and repositories (T31.5). Not part of `pnpm test` or CI: it needs a server
 * with a database. Run the mobile live test first (apps/mobile/e2e) so there are
 * customers to find; this one creates its own staff member.
 *
 *   cd apps/console
 *   E2E_API_URL=http://localhost:8080 E2E_DATABASE_URL=postgres://nem:nem@localhost:5433/nem?sslmode=disable \
 *   E2E_DB_CONTAINER=nem-bank-postgres-1 \
 *     npx vitest run -c vitest.e2e.config.mts
 *
 * `go` must be on PATH: the staff account is made with the API's own `create-staff`
 * command, as an operator would.
 */
import type { StaffSession } from '@nem/contracts';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createHttpDispatcher } from '../src/data/http/client';
import { repositoriesFromDispatcher } from '../src/data/repositories';
import { totp } from '../src/lib/totp';

const API = process.env.E2E_API_URL;
const DB_URL = process.env.E2E_DATABASE_URL;
const CONTAINER = process.env.E2E_DB_CONTAINER ?? 'nem-bank-postgres-1';
const live = API && DB_URL ? describe : describe.skip;

const STAFF_PASSWORD = `Zr4-${Date.now().toString(36)}-qL8-vN2x`;
const stamp = Date.now().toString(36);

const psql = (sql: string) =>
  execFileSync('docker', ['exec', CONTAINER, 'psql', '-U', 'nem', '-d', 'nem', '-tA', '-c', sql])
    .toString()
    .trim();

live('live API: console from staff sign-in to the developer portal', () => {
  const staffEmail = `e2e.${stamp}@nem.bank`;
  let staffSession: StaffSession | null = null;
  let developerSession: Parameters<ReturnType<typeof dispatcher>['customer']['save']>[0] | null =
    null;

  function dispatcher() {
    const customer = {
      get: () => developerSession,
      save: (s: NonNullable<typeof developerSession>) => {
        developerSession = s;
      },
      clear: () => {
        developerSession = null;
      },
    };
    return {
      customer,
      dispatch: createHttpDispatcher({
        baseUrl: API!,
        staffToken: () => staffSession?.access_token ?? null,
        customer,
      }),
    };
  }
  const { dispatch } = dispatcher();
  const repos = repositoriesFromDispatcher(dispatch);

  it('creates a staff member with the operator command and signs in with a TOTP code', async () => {
    execFileSync(
      'go',
      [
        'run',
        './cmd/api',
        'create-staff',
        '-name',
        'E2E Admin',
        '-email',
        staffEmail,
        '-roles',
        'admin',
      ],
      {
        cwd: new URL('../../api', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
        env: { ...process.env, DATABASE_URL: DB_URL, STAFF_PASSWORD },
      },
    );
    const challenge = await repos.auth.login({
      body: { email: staffEmail, password: STAFF_PASSWORD },
    });
    // First sign-in enrols an authenticator; the secret is in the otpauth URI.
    const secret = new URL(challenge.totp_enrolment!.otpauth_uri).searchParams.get('secret')!;
    staffSession = await repos.auth.verifyTotp({
      body: { challenge_id: challenge.challenge_id, code: totp(secret, Date.now()) },
    });
    expect(staffSession.staff.roles).toEqual(['admin']);
    expect((await repos.auth.me({})).email).toBe(staffEmail);
  });

  it('reads the back office as admin: dashboard, customers, ledger, config, audit, queues', async () => {
    const dash = await repos.dashboard.get({});
    expect(Number(dash.users_total)).toBeGreaterThan(0);

    const found = await repos.customers.search({ query: { q: 'alice' } });
    expect(found.data.length).toBeGreaterThan(0);
    const customer = await repos.customers.get({ path: { user_id: found.data[0]!.user_id } });
    expect(customer.accounts.length).toBeGreaterThan(0);

    const trial = await repos.ledger.trialBalance({});
    // Every currency's debits and credits net to zero: the ledger's core invariant.
    expect(trial.balanced).toBe(true);
    expect(trial.currencies.length).toBeGreaterThan(0);

    expect((await repos.config.get({})).version).toBeGreaterThan(0);
    expect((await repos.audit.verify({ body: {} })).valid).toBe(true);
    for (const list of [
      repos.kyc.list,
      repos.fraud.list,
      repos.disputes.list,
      repos.approvals.list,
    ]) {
      expect((await list({})).data).toBeInstanceOf(Array);
    }
  });

  it('refuses a request with no staff session', async () => {
    const saved = staffSession;
    staffSession = null;
    await expect(repos.dashboard.get({})).rejects.toMatchObject({ status: 401 });
    staffSession = saved;
  });

  it('signs the developer portal in as a customer, creates a key behind a PIN, and revokes it', async () => {
    const email = psql(
      "SELECT email FROM users WHERE email LIKE 'alice.%@example.com' ORDER BY created_at DESC LIMIT 1",
    );
    expect(email).not.toBe('');
    developerSession = await repos.developerAuth.login({
      body: {
        identifier: email,
        password: 'Correct-Horse-9!',
        device: {
          name: 'Developer portal (web)',
          platform: 'web',
          public_key: randomBytes(32).toString('base64url'),
          hardware_backed: false,
        },
      },
    });

    const challenge = await repos.developerAuth.startStepUp({ body: { purpose: 'api_key' } });
    expect(challenge.methods).toContain('pin');
    const { step_up_token } = await repos.developerAuth.verifyStepUp({
      path: { step_up_id: challenge.step_up_id },
      body: { pin: '4827' },
    });

    const created = await repos.developer.createKey({
      body: { name: 'E2E key', scopes: ['accounts_read'] },
      stepUpToken: step_up_token,
    });
    expect(created.secret.startsWith('nem_test_')).toBe(true);
    const listed = await repos.developer.listKeys({});
    expect(listed.data.some((k) => k.id === created.key.id)).toBe(true);

    await repos.developer.revokeKey({ path: { key_id: created.key.id } });
    const after = await repos.developer.listKeys({});
    expect(after.data.find((k) => k.id === created.key.id)?.revoked_at).not.toBeNull();

    // The step-up token was single use: a second key with it is refused.
    await expect(
      repos.developer.createKey({
        body: { name: 'Replay', scopes: ['accounts_read'] },
        stepUpToken: step_up_token,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('creates a webhook endpoint, sends a test event and reads the delivery log', async () => {
    const created = await repos.developer.createEndpoint({
      body: { url: 'https://example.com/hooks/nem', events: ['test.ping'] },
    });
    expect(created.signing_secret.startsWith('whsec_')).toBe(true);
    const sent = await repos.developer.sendTest({ path: { endpoint_id: created.endpoint.id } });
    expect(sent.endpoint_id).toBe(created.endpoint.id);
    const log = await repos.developer.listDeliveries({
      path: { endpoint_id: created.endpoint.id },
      query: {},
    });
    expect(log.data.length).toBeGreaterThan(0);
    await repos.developer.deleteEndpoint({ path: { endpoint_id: created.endpoint.id } });
  });
});
