import type { Schema } from '@nem/contracts';
import { checkPassword, isWeakPin, signupRequestSchema } from '@nem/shared';

import { problem } from '../../errors';
import type { AuthRepo, DevicesRepo, UsersRepo } from '../../repositories';
import { addMinutes, maskEmail } from '../convert';
import type { MockBank } from '../runtime';
import type { OtpRecord } from '../world';

/** The demo bank sends no email: every OTP is this code, and the UI says so. */
export const DEMO_OTP = '123456';
export const DEMO_PASSWORD = 'Demo1234!';
/** Tolu's transaction PIN; the lock screen shows it in demo sessions. */
export const DEMO_PIN = '2580';
const OTP_TTL_MINUTES = 10;
const OTP_RESEND_SECONDS = 60;
const OTP_ATTEMPTS = 5;
const PIN_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 30;
const STEP_UP_TTL_MINUTES = 5;
/** AUTH-8: reduced limits and alerts for a day after a new device signs in. */
const NEW_DEVICE_COOL_OFF_HOURS = 24;

const token = (bank: MockBank, kind: string) => `mock_${kind}_${bank.id().replaceAll('-', '')}`;

function createOtp(
  bank: MockBank,
  purpose: OtpRecord['purpose'],
  destination: string,
  extra: Partial<OtpRecord> = {},
): Schema<'OtpChallenge'> {
  const id = bank.id();
  const now = bank.now();
  const record: OtpRecord = {
    code: DEMO_OTP,
    purpose,
    destination,
    expiresAt: addMinutes(now, OTP_TTL_MINUTES).toISOString(),
    resendAt: new Date(now.getTime() + OTP_RESEND_SECONDS * 1000).toISOString(),
    attempts: OTP_ATTEMPTS,
    ...extra,
  };
  bank.world.otps[id] = record;
  return challengeOf(id, record);
}

function challengeOf(id: string, r: OtpRecord): Schema<'OtpChallenge'> {
  return {
    challenge_id: id,
    channel: 'email',
    destination_masked: maskEmail(r.destination),
    expires_at: r.expiresAt,
    resend_available_at: r.resendAt,
    attempts_remaining: r.attempts,
  };
}

/** Checks an OTP with AUTH-2's expiry and attempt rules. */
function checkOtp(bank: MockBank, challengeId: string, code: string): OtpRecord {
  const record = bank.world.otps[challengeId];
  if (!record) throw problem(404, 'not_found', 'This code has expired. Ask for a new one.');
  if (record.expiresAt < bank.nowIso()) {
    throw problem(410, 'otp_expired', 'This code has expired. Ask for a new one.');
  }
  if (record.attempts <= 0) {
    throw problem(429, 'rate_limited', 'Too many wrong codes. Ask for a new one.');
  }
  if (record.code !== code) {
    record.attempts -= 1;
    throw problem(422, 'invalid_otp', 'That code is not right', {
      detail: `${record.attempts} attempt${record.attempts === 1 ? '' : 's'} left.`,
    });
  }
  return record;
}

function currentDevice(bank: MockBank) {
  return bank.world.devices.find((d) => d.id === bank.world.currentDeviceId)!;
}

/**
 * Binds a device's public key. A login on a new device starts the cool-off and
 * alerts the others (AUTH-8); the first device, at sign-up, has nothing to alert.
 */
function bindNewDevice(
  bank: MockBank,
  registration: Schema<'DeviceRegistration'>,
  { coolOff = true }: { coolOff?: boolean } = {},
) {
  const now = bank.now();
  const device: Schema<'Device'> = {
    id: bank.id(),
    name: registration.name,
    platform: registration.platform,
    current: false,
    trusted: !coolOff,
    hardware_backed: registration.hardware_backed ?? false,
    key_fingerprint: `SHA256:${registration.public_key.slice(0, 12)}`,
    bound_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    cool_off_until: coolOff ? addMinutes(now, NEW_DEVICE_COOL_OFF_HOURS * 60).toISOString() : null,
    location_hint: 'Lagos, NG',
  };
  bank.world.devices.push(device);
  if (!coolOff) return device;
  bank.notify({
    category: 'security',
    title: 'New device signed in',
    body: `${device.name} signed in to your account. Limits are lower for 24 hours. Not you? Revoke it now.`,
    deep_link: 'nembank://security/devices',
  });
  return device;
}

function session(bank: MockBank, deviceId: string): Schema<'AuthSession'> {
  bank.world.currentDeviceId = deviceId;
  const now = bank.now();
  const device = bank.world.devices.find((d) => d.id === deviceId)!;
  device.last_seen_at = now.toISOString();
  bank.world.sessions = bank.world.sessions.filter((s) => s.device_id !== deviceId);
  bank.world.sessions.forEach((s) => (s.current = false));
  bank.world.sessions.push({
    id: bank.id(),
    device_id: deviceId,
    device_name: device.name,
    current: true,
    created_at: now.toISOString(),
    last_active_at: now.toISOString(),
    ip_location: 'Lagos, NG',
  });
  return {
    access_token: token(bank, 'access'),
    access_token_expires_at: addMinutes(now, 10).toISOString(),
    refresh_token: token(bank, 'refresh'),
    refresh_token_expires_at: addMinutes(now, 30 * 24 * 60).toISOString(),
    token_type: 'Bearer',
    user: bank.user,
    device: devicesView(bank).find((d) => d.id === deviceId)!,
  };
}

function devicesView(bank: MockBank): Schema<'Device'>[] {
  return bank.world.devices.map((d) => ({ ...d, current: d.id === bank.world.currentDeviceId }));
}

/** PIN check with AUTH-4 lockout. The duress PIN also "works" (SEC-5), silently. */
export function checkPin(bank: MockBank, pin: string): Schema<'PinVerification'> {
  const auth = bank.world.auth;
  if (auth.pinLockedUntil && auth.pinLockedUntil > bank.nowIso()) {
    return { valid: false, attempts_remaining: 0, locked_until: auth.pinLockedUntil };
  }
  if (pin === auth.pin || (auth.duressPin !== null && pin === auth.duressPin)) {
    auth.pinFailures = 0;
    auth.pinLockedUntil = null;
    return { valid: true, attempts_remaining: PIN_ATTEMPTS, locked_until: null };
  }
  auth.pinFailures += 1;
  if (auth.pinFailures >= PIN_ATTEMPTS) {
    auth.pinFailures = 0;
    auth.pinLockedUntil = addMinutes(bank.now(), PIN_LOCK_MINUTES).toISOString();
    return { valid: false, attempts_remaining: 0, locked_until: auth.pinLockedUntil };
  }
  return { valid: false, attempts_remaining: PIN_ATTEMPTS - auth.pinFailures, locked_until: null };
}

export function assertStrongPin(pin: string, dateOfBirth?: string) {
  if (!/^(\d{4}|\d{6})$/.test(pin)) throw problem(422, 'validation_failed', 'Use 4 or 6 digits');
  if (isWeakPin(pin, dateOfBirth)) {
    throw problem(422, 'weak_pin', 'Pick a PIN that is harder to guess', {
      errors: [{ field: '/pin', code: 'weak', message: 'Pick a PIN that is harder to guess' }],
    });
  }
}

export function authRepo(bank: MockBank): AuthRepo {
  return {
    async startSignup({ body }) {
      const checked = signupRequestSchema.safeParse(body);
      if (!checked.success) {
        const errors = checked.error.issues.map((issue) => ({
          field: `/${issue.path.join('/')}`,
          code: 'invalid',
          message: issue.message,
        }));
        throw problem(400, 'validation_failed', 'Check the highlighted details', { errors });
      }
      // The seeded customer already holds this email: the realistic "already registered" path.
      if (checked.data.email === bank.user.email.toLowerCase()) {
        throw problem(409, 'email_taken', 'An account already uses this email', {
          errors: [
            {
              field: '/email',
              code: 'taken',
              message: 'An account already uses this email. Log in instead.',
            },
          ],
        });
      }
      const signup = { ...body, ...checked.data };
      const otp = createOtp(bank, 'signup', signup.email, { signup });
      return { signup_id: otp.challenge_id, otp };
    },
    async completeSignup({ body }) {
      const record = bank.world.otps[body.signup_id];
      if (
        !record?.signup ||
        !record.verified ||
        body.verification_token !== `verified_${body.signup_id}`
      ) {
        throw problem(403, 'invalid_otp', 'Verify your email first');
      }
      const { first_name, last_name, email, phone, date_of_birth } = record.signup;
      const strength = checkPassword(body.password, {
        firstName: first_name,
        lastName: last_name,
        email,
        dateOfBirth: date_of_birth,
      });
      if (!strength.acceptable) {
        throw problem(422, 'weak_password', 'Pick a stronger password', {
          errors: [{ field: '/password', code: 'weak', message: strength.problems[0]! }],
        });
      }
      if (body.pin !== undefined) assertStrongPin(body.pin, date_of_birth);
      // The offline demo has one seeded customer: a new signup takes over the persona.
      Object.assign(bank.user, {
        first_name,
        last_name,
        email,
        phone,
        date_of_birth,
        preferred_name: null,
        has_pin: body.pin !== undefined,
      });
      bank.world.auth.password = body.password;
      if (body.pin !== undefined) {
        Object.assign(bank.world.auth, { pin: body.pin, pinFailures: 0, pinLockedUntil: null });
      }
      delete bank.world.otps[body.signup_id];
      return session(bank, bindNewDevice(bank, body.device, { coolOff: false }).id);
    },
    async verifyOtp({ body }) {
      const record = checkOtp(bank, body.challenge_id, body.code);
      record.verified = true;
      return {
        verification_token: `verified_${body.challenge_id}`,
        expires_at: addMinutes(bank.now(), 15).toISOString(),
      };
    },
    async resendOtp({ body }) {
      const record = bank.world.otps[body.challenge_id];
      if (!record) throw problem(404, 'not_found', 'Start again to get a new code');
      if (record.resendAt > bank.nowIso()) {
        throw problem(429, 'rate_limited', 'Wait a moment before asking again', {
          retry_at: record.resendAt,
        });
      }
      const now = bank.now();
      record.expiresAt = addMinutes(now, OTP_TTL_MINUTES).toISOString();
      record.resendAt = new Date(now.getTime() + OTP_RESEND_SECONDS * 1000).toISOString();
      record.attempts = OTP_ATTEMPTS;
      return challengeOf(body.challenge_id, record);
    },
    async login({ body }) {
      const id = body.identifier.trim().toLowerCase().replace(/^@/, '');
      const user = bank.user;
      const matches = [user.email.toLowerCase(), user.phone, user.nemtag ?? ''].includes(id);
      if (!matches || body.password !== bank.world.auth.password) {
        throw problem(401, 'invalid_credentials', 'Email or password is not right');
      }
      const known = bank.world.devices.find((d) => d.id === body.device_id);
      if (known) return session(bank, known.id);
      if (!body.device) throw problem(422, 'validation_failed', 'Register this device to sign in');
      return session(bank, bindNewDevice(bank, body.device).id);
    },
    async createDeviceChallenge({ body }) {
      if (!bank.world.devices.some((d) => d.id === body.device_id)) {
        throw problem(404, 'not_found', 'This device is not bound to an account');
      }
      const id = bank.id();
      bank.world.stepUps[id] = {
        purpose: 'device_bind',
        expiresAt: addMinutes(bank.now(), 2).toISOString(),
        otpId: body.device_id,
      };
      return {
        challenge_id: id,
        nonce: bank.id().replaceAll('-', ''),
        expires_at: bank.world.stepUps[id].expiresAt,
      };
    },
    async loginWithDevice({ body }) {
      const challenge = bank.world.stepUps[body.challenge_id];
      // Signatures are verified by the server (Phase 2); the mock checks the challenge.
      if (
        !challenge ||
        challenge.otpId !== body.device_id ||
        challenge.expiresAt < bank.nowIso() ||
        !body.signature
      ) {
        throw problem(401, 'invalid_signature', 'Sign in with your password instead');
      }
      delete bank.world.stepUps[body.challenge_id];
      return session(bank, body.device_id);
    },
    async startDemoSession({ body }) {
      if (body.persona !== 'tolu') {
        throw problem(422, 'validation_failed', 'The offline demo has one persona, Tolu');
      }
      return session(bank, bank.world.currentDeviceId);
    },
    async refresh({ body }) {
      if (!body.refresh_token.startsWith('mock_refresh_')) {
        throw problem(401, 'invalid_token', 'Your session has ended. Sign in again.');
      }
      return session(bank, bank.world.currentDeviceId);
    },
    async logout({ body }) {
      bank.world.sessions = body.all_devices
        ? []
        : bank.world.sessions.filter((s) => s.device_id !== bank.world.currentDeviceId);
    },
    async forgotPassword({ body }) {
      // The same answer for unknown emails, so the form cannot be used to find accounts.
      return createOtp(bank, 'password_reset', body.email.trim().toLowerCase());
    },
    async resetPassword({ body }) {
      const record = checkOtp(bank, body.challenge_id, body.code);
      // An email with no account got a code nobody can read: it never matches.
      if (
        record.purpose !== 'password_reset' ||
        record.destination !== bank.user.email.toLowerCase()
      ) {
        throw problem(422, 'invalid_otp', 'That code is not right');
      }
      const { first_name, last_name, email, date_of_birth } = bank.user;
      const strength = checkPassword(body.new_password, {
        firstName: first_name,
        lastName: last_name,
        email,
        dateOfBirth: date_of_birth,
      });
      if (!strength.acceptable) {
        throw problem(422, 'weak_password', 'Pick a stronger password', {
          errors: [{ field: '/new_password', code: 'weak', message: strength.problems[0]! }],
        });
      }
      bank.world.auth.password = body.new_password;
      delete bank.world.otps[body.challenge_id];
      // A new password signs out every session, including any an attacker held.
      bank.world.sessions = [];
    },
    async startStepUp({ body }) {
      const otp = createOtp(bank, 'step_up', bank.user.email);
      const id = bank.id();
      const question = bank.world.auth.securityQuestion;
      bank.world.stepUps[id] = {
        purpose: body.purpose,
        expiresAt: otp.expires_at,
        otpId: otp.challenge_id,
      };
      return {
        step_up_id: id,
        purpose: body.purpose,
        methods: question ? ['pin', 'email_otp', 'security_question'] : ['pin', 'email_otp'],
        security_question: question?.question ?? null,
        otp,
        expires_at: otp.expires_at,
      };
    },
    async verifyStepUp({ path, body }) {
      const stepUp = bank.world.stepUps[path.step_up_id];
      if (!stepUp || stepUp.expiresAt < bank.nowIso()) {
        throw problem(410, 'otp_expired', 'This check has expired. Start again.');
      }
      if (body.pin !== undefined) {
        const result = checkPin(bank, body.pin);
        if (!result.valid) {
          throw problem(
            result.locked_until ? 423 : 422,
            result.locked_until ? 'pin_locked' : 'invalid_pin',
            'Wrong PIN',
            {
              detail: result.locked_until
                ? 'Too many wrong PINs. Try again in 30 minutes.'
                : `${result.attempts_remaining} attempts left.`,
            },
          );
        }
      } else if (body.otp_code !== undefined) {
        checkOtp(bank, stepUp.otpId, body.otp_code);
      } else if (body.security_answer !== undefined) {
        const q = bank.world.auth.securityQuestion;
        if (!q || q.answer !== body.security_answer.trim().toLowerCase()) {
          throw problem(422, 'invalid_answer', 'That answer is not right');
        }
      } else {
        throw problem(422, 'validation_failed', 'Enter your PIN or the code we sent');
      }
      delete bank.world.stepUps[path.step_up_id];
      const value = token(bank, 'stepup');
      const expiresAt = addMinutes(bank.now(), STEP_UP_TTL_MINUTES).toISOString();
      bank.world.stepUpTokens[value] = { purpose: stepUp.purpose, expiresAt };
      return { step_up_token: value, purpose: stepUp.purpose, expires_at: expiresAt };
    },
  };
}

const NEMTAG = /^[a-z0-9_]{3,20}$/;

export function usersRepo(bank: MockBank): UsersRepo {
  const taken = (tag: string) =>
    bank.world.people.some((p) => p.nemtag === tag) || ['nem', 'admin', 'support'].includes(tag);
  return {
    async getMe() {
      return bank.user;
    },
    async updateMe({ body }) {
      if (body.preferred_name !== undefined)
        bank.user.preferred_name = body.preferred_name?.trim() || null;
      return bank.user;
    },
    async checkNemtag({ path }) {
      const tag = path.nemtag.toLowerCase();
      const available = NEMTAG.test(tag) && !taken(tag) && tag !== bank.user.nemtag;
      const base = tag.replace(/[^a-z0-9_]/g, '').slice(0, 16) || 'nem';
      return {
        nemtag: tag,
        available,
        suggestions: available
          ? []
          : [`${base}_ng`, `${base}${bank.now().getUTCFullYear() % 100}`, `the_${base}`].filter(
              (s) => !taken(s),
            ),
      };
    },
    async setNemtag({ body }) {
      const tag = body.nemtag.toLowerCase();
      if (!NEMTAG.test(tag))
        throw problem(422, 'validation_failed', 'Use 3–20 letters, numbers or _');
      if (taken(tag)) throw problem(409, 'nemtag_taken', `@${tag} is taken`);
      bank.user.nemtag = tag;
      return bank.user;
    },
    async setPin({ body }) {
      if (bank.user.has_pin)
        throw problem(409, 'pin_exists', 'Change your PIN from Security instead');
      assertStrongPin(body.pin, bank.user.date_of_birth);
      bank.world.auth.pin = body.pin;
      bank.user.has_pin = true;
    },
    async verifyPin({ body }) {
      return checkPin(bank, body.pin);
    },
    async resetPin({ body, stepUpToken }) {
      bank.consumeStepUp(stepUpToken, 'pin_reset');
      assertStrongPin(body.pin, bank.user.date_of_birth);
      if (body.pin === bank.world.auth.duressPin) {
        throw problem(422, 'validation_failed', 'Your PIN and duress PIN must be different');
      }
      bank.world.auth.pin = body.pin;
      bank.world.auth.pinFailures = 0;
      bank.world.auth.pinLockedUntil = null;
    },
    async getPreferences() {
      return bank.world.preferences;
    },
    async setPreferences({ body }) {
      bank.world.preferences = body;
      return body;
    },
  };
}

export function devicesRepo(bank: MockBank): DevicesRepo {
  return {
    async list() {
      return { data: devicesView(bank) };
    },
    async bind({ body, stepUpToken }) {
      bank.consumeStepUp(stepUpToken, 'device_bind');
      return bindNewDevice(bank, body);
    },
    async revoke({ path }) {
      if (path.device_id === currentDevice(bank).id) {
        throw problem(409, 'invalid_state', 'You cannot remove the device you are using');
      }
      if (!bank.world.devices.some((d) => d.id === path.device_id)) {
        throw problem(404, 'not_found', 'Device not found');
      }
      bank.world.devices = bank.world.devices.filter((d) => d.id !== path.device_id);
      bank.world.sessions = bank.world.sessions.filter((s) => s.device_id !== path.device_id);
    },
  };
}
