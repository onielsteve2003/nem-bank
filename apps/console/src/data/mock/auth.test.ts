import { describe, expect, it } from 'vitest';

import { totp } from '@/lib/totp';

import { isApiError } from '../errors';
import { repositoriesFromDispatcher } from '../repositories';
import { switchDemoRole } from './auth';
import { createMockDispatcher } from './index';
import { DEMO_PASSWORD, createMockState, findAccountByEmail } from './state';

const NOW = 1_800_000_000_000;

function setup() {
  const state = createMockState(() => NOW);
  let token: string | null = null;
  const repos = repositoriesFromDispatcher(
    createMockDispatcher({ latencyMs: 0, state, getAccessToken: () => token }),
  );
  return { state, repos, setToken: (t: string | null) => (token = t) };
}

const is = (code: string) => (e: unknown) => isApiError(e, code);

describe('mock staff auth', () => {
  it('signs in with password then a real TOTP code', async () => {
    const { state, repos, setToken } = setup();
    const challenge = await repos.auth.login({
      body: { email: 'Compliance@nem.bank', password: DEMO_PASSWORD },
    });
    expect(challenge.totp_enrolment).toBeNull();

    const secret = findAccountByEmail(state, 'compliance@nem.bank')!.totpSecret;
    const session = await repos.auth.verifyTotp({
      body: { challenge_id: challenge.challenge_id, code: totp(secret, NOW) },
    });
    expect(session.staff.roles).toEqual(['compliance']);
    expect(Date.parse(session.expires_at) - NOW).toBe(8 * 60 * 60_000);

    setToken(session.access_token);
    await expect(repos.auth.me()).resolves.toMatchObject({ email: 'compliance@nem.bank' });
  });

  it('gives one answer for an unknown email and a wrong password', async () => {
    const { repos } = setup();
    const wrongPass = { email: 'admin@nem.bank', password: 'not-the-password' };
    const unknown = { email: 'nobody@nem.bank', password: DEMO_PASSWORD };
    await expect(repos.auth.login({ body: wrongPass })).rejects.toSatisfy(
      is('invalid_credentials'),
    );
    await expect(repos.auth.login({ body: unknown })).rejects.toSatisfy(is('invalid_credentials'));
  });

  it('asks a never-enrolled staff member to set up an authenticator', async () => {
    const { repos } = setup();
    const challenge = await repos.auth.login({
      body: { email: 'support@nem.bank', password: DEMO_PASSWORD },
    });
    expect(challenge.totp_enrolment?.otpauth_uri).toMatch(/^otpauth:\/\/totp\//);
  });

  it('rejects a replayed code and locks the challenge after 5 wrong codes', async () => {
    const { state, repos } = setup();
    const body = { email: 'admin@nem.bank', password: DEMO_PASSWORD };
    const code = totp(findAccountByEmail(state, 'admin@nem.bank')!.totpSecret, NOW);

    const first = await repos.auth.login({ body });
    await repos.auth.verifyTotp({ body: { challenge_id: first.challenge_id, code } });
    const second = await repos.auth.login({ body });
    await expect(
      repos.auth.verifyTotp({ body: { challenge_id: second.challenge_id, code } }),
    ).rejects.toSatisfy(is('invalid_otp'));

    for (let i = 0; i < 4; i++) {
      await expect(
        repos.auth.verifyTotp({ body: { challenge_id: second.challenge_id, code: '000000' } }),
      ).rejects.toSatisfy(is('invalid_otp'));
    }
    await expect(
      repos.auth.verifyTotp({ body: { challenge_id: second.challenge_id, code: '000000' } }),
    ).rejects.toSatisfy(is('rate_limited'));
  });

  it('enforces x-roles: 401 without a session, 403 for the wrong role', async () => {
    const { state, repos, setToken } = setup();
    await expect(repos.audit.list()).rejects.toSatisfy(is('unauthorized'));
    setToken(switchDemoRole(state, 'support').access_token);
    await expect(repos.audit.list()).rejects.toSatisfy(is('forbidden'));
    setToken(switchDemoRole(state, 'admin').access_token);
    await expect(repos.audit.list()).rejects.toSatisfy(is('not_implemented'));
  });

  it('revokes the token on logout', async () => {
    const { state, repos, setToken } = setup();
    setToken(switchDemoRole(state, 'finance').access_token);
    await repos.auth.logout();
    await expect(repos.auth.me()).rejects.toSatisfy(is('unauthorized'));
  });
});
