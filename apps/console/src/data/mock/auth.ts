import type { StaffRole, StaffSession } from '@nem/contracts';

import { otpauthUri, verifyTotp } from '@/lib/totp';

import { problem } from '../errors';
import type { Handlers } from './handlers';
import {
  DEMO_PASSWORD,
  findAccountByEmail,
  newId,
  type MockState,
  type StaffAccount,
} from './state';

const CHALLENGE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 8 * 60 * 60_000;
const MAX_TOTP_ATTEMPTS = 5;

function openSession(state: MockState, account: StaffAccount): StaffSession {
  const token = `staff_${newId()}`;
  const now = state.now();
  state.sessions.set(token, account.staff.id);
  account.staff = {
    ...account.staff,
    totp_enrolled: true,
    last_login_at: new Date(now).toISOString(),
  };
  return {
    access_token: token,
    expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
    staff: account.staff,
  };
}

export const authHandlers: Handlers = {
  staffLogin: ({ body }, { state }) => {
    const account = findAccountByEmail(state, body.email);
    // One message for a wrong email or password, so the form can't be used to find staff.
    if (!account || body.password !== DEMO_PASSWORD) {
      throw problem(401, 'invalid_credentials', 'Email or password is wrong');
    }
    const challengeId = newId();
    const expiresAt = state.now() + CHALLENGE_TTL_MS;
    state.challenges.set(challengeId, { staffId: account.staff.id, expiresAt, attempts: 0 });
    return {
      challenge_id: challengeId,
      expires_at: new Date(expiresAt).toISOString(),
      totp_enrolment: account.staff.totp_enrolled
        ? null
        : { otpauth_uri: otpauthUri(account.totpSecret, account.staff.email) },
    };
  },

  staffVerifyTotp: ({ body }, { state }) => {
    const challenge = state.challenges.get(body.challenge_id);
    if (!challenge || challenge.expiresAt <= state.now()) {
      state.challenges.delete(body.challenge_id);
      throw problem(401, 'otp_expired', 'That sign-in expired. Start again.');
    }
    if (challenge.attempts >= MAX_TOTP_ATTEMPTS) {
      state.challenges.delete(body.challenge_id);
      throw problem(429, 'rate_limited', 'Too many wrong codes. Start again.');
    }
    const account = state.accounts.get(challenge.staffId);
    const counter = account ? verifyTotp(account.totpSecret, body.code, state.now()) : null;
    if (!account || counter === null || counter === account.lastTotpCounter) {
      challenge.attempts += 1;
      throw problem(401, 'invalid_otp', 'That code is wrong or already used');
    }
    account.lastTotpCounter = counter;
    state.challenges.delete(body.challenge_id);
    return openSession(state, account);
  },

  staffLogout: (_input, { state, token }) => {
    if (token) state.sessions.delete(token);
  },

  getStaffMe: (_input, { staff }) => {
    if (!staff) throw problem(401, 'unauthorized', 'Sign in again');
    return staff;
  },
};

/**
 * Demo only: sign in as the seeded staff member who holds `role`, skipping TOTP, so a
 * visitor can see how each role's console differs. Not part of the API.
 */
export function switchDemoRole(state: MockState, role: StaffRole): StaffSession {
  const account = [...state.accounts.values()].find((a) => a.staff.roles.includes(role));
  if (!account) throw new Error(`no demo staff member has the ${role} role`);
  return openSession(state, account);
}
