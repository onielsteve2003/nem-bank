import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { getRandomBytes } from 'expo-crypto';

import type { DeviceSigner, SigningRequest } from '@/data/http';

import { deleteSecret, KEY_IS_HARDWARE_BACKED, readSecret, saveSecret } from './keyVault';
import { secureStorage } from './secureStorage';

// Device binding (AUTH-6). Each install makes an Ed25519 key pair; the bank keeps
// the public key and the private key never leaves this device's secure storage.
// Money-moving requests carry a signature only this device can make (T3.11).

// Hermes has no WebCrypto, so noble signs with the pure-JS SHA-512.
ed.hashes.sha512 = sha512;

const SECRET_KEY = 'nem.device.secret';
const INFO_KEY = 'nem.device.info';

export interface DeviceKeyInfo {
  /** Base64url raw 32-byte public key, as DeviceRegistration.public_key. */
  publicKey: string;
  /** Reading the private key needs Face ID / fingerprint (the user opted in). */
  biometric: boolean;
  hardwareBacked: boolean;
  /** The bank's ID for this device, known once registration succeeds. */
  deviceId: string | null;
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += B64URL[(n >> (18 - 6 * c)) & 63];
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    const value = B64URL.indexOf(char);
    if (value < 0) throw new Error('Not base64url');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

async function saveInfo(info: DeviceKeyInfo): Promise<void> {
  await secureStorage.setItem(INFO_KEY, JSON.stringify(info));
}

/** What is known about this device's key, or null before sign-up / after sign-out removed it. */
export async function getDeviceKeyInfo(): Promise<DeviceKeyInfo | null> {
  try {
    const raw = await secureStorage.getItem(INFO_KEY);
    return raw ? (JSON.parse(raw) as DeviceKeyInfo) : null;
  } catch {
    return null;
  }
}

/** Makes a fresh key pair, replacing any old one. Only the public half is returned. */
export async function createDeviceKey({ biometric }: { biometric: boolean }) {
  const secret = getRandomBytes(32);
  const info: DeviceKeyInfo = {
    publicKey: toBase64Url(ed.getPublicKey(secret)),
    biometric,
    hardwareBacked: KEY_IS_HARDWARE_BACKED,
    deviceId: null,
  };
  await deleteSecret(SECRET_KEY).catch(() => undefined);
  await saveSecret(SECRET_KEY, toBase64Url(secret), biometric);
  secret.fill(0);
  await saveInfo(info);
  return info;
}

/** Records the bank's device ID once the public key has been registered. */
export async function setDeviceId(deviceId: string): Promise<void> {
  const info = await getDeviceKeyInfo();
  if (info) await saveInfo({ ...info, deviceId });
}

export async function deleteDeviceKey(): Promise<void> {
  await deleteSecret(SECRET_KEY).catch(() => undefined);
  await secureStorage.removeItem(INFO_KEY);
}

/** The exact text a request signature covers: `METHOD\npath\ntimestamp\nnonce\nsha256hex(body)`. */
export function signingPayload(request: SigningRequest): string {
  return [
    request.method.toUpperCase(),
    request.path,
    request.timestamp,
    request.nonce,
    bytesToHex(sha256(utf8ToBytes(request.body))),
  ].join('\n');
}

/**
 * Signs `message` with the device key: base64url, 64 bytes. A biometric-bound key
 * shows the system prompt first; cancelling it rejects, so nothing is signed.
 */
export async function signWithDeviceKey(
  message: string,
  prompt = 'Approve with Nem Bank',
): Promise<string> {
  const info = await getDeviceKeyInfo();
  if (!info) throw new Error('This device has no key yet');
  const stored = await readSecret(SECRET_KEY, info.biometric, prompt);
  if (!stored) throw new Error('The device key is missing');
  const secret = fromBase64Url(stored);
  try {
    return toBase64Url(ed.sign(utf8ToBytes(message), secret));
  } finally {
    secret.fill(0);
  }
}

/** The http client's signer (T3.11 hook): signs each money-moving request. */
export const deviceSigner: DeviceSigner = async (request) => {
  const info = await getDeviceKeyInfo();
  if (!info?.deviceId) throw new Error('This device is not bound yet');
  return { deviceId: info.deviceId, signature: await signWithDeviceKey(signingPayload(request)) };
};
