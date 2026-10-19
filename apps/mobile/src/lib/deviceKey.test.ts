import * as ed from '@noble/ed25519';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import * as SecureStore from 'expo-secure-store';

import {
  createDeviceKey,
  deleteDeviceKey,
  deviceSigner,
  fromBase64Url,
  getDeviceKeyInfo,
  setDeviceId,
  signingPayload,
  signWithDeviceKey,
  toBase64Url,
} from './deviceKey';

const REQUEST = {
  method: 'post',
  path: '/v1/transfers?dry_run=false',
  timestamp: '2026-10-19T12:00:00Z',
  nonce: 'n1',
  body: '{"amount":"100"}',
};

afterEach(() => deleteDeviceKey());

describe('base64url', () => {
  it('round-trips any length without padding', () => {
    for (const length of [0, 1, 2, 3, 32, 64]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) % 256);
      const text = toBase64Url(bytes);
      expect(text).not.toMatch(/[=+/]/);
      expect(fromBase64Url(text)).toEqual(bytes);
    }
    expect(toBase64Url(Uint8Array.of(0xfb, 0xff))).toBe('-_8');
  });
});

describe('device key', () => {
  it('makes a 32-byte public key in the contract format and keeps the secret biometric-bound', async () => {
    const info = await createDeviceKey({ biometric: true });
    expect(info.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(info).toMatchObject({ biometric: true, hardwareBacked: true, deviceId: null });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      'nem.device.secret',
      expect.any(String),
      expect.objectContaining({ requireAuthentication: true }),
    );
    expect(await getDeviceKeyInfo()).toEqual(info);
  });

  it('signs so that the public key verifies, and the signature covers the request', async () => {
    const { publicKey } = await createDeviceKey({ biometric: false });
    const message = signingPayload(REQUEST);
    expect(message.split('\n')).toEqual([
      'POST',
      '/v1/transfers?dry_run=false',
      '2026-10-19T12:00:00Z',
      'n1',
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);

    const signature = fromBase64Url(await signWithDeviceKey(message));
    const key = fromBase64Url(publicKey);
    expect(signature).toHaveLength(64);
    expect(ed.verify(signature, utf8ToBytes(message), key)).toBe(true);
    const tampered = signingPayload({ ...REQUEST, body: '{"amount":"900"}' });
    expect(ed.verify(signature, utf8ToBytes(tampered), key)).toBe(false);
  });

  it('signs requests only once the bank has registered the device', async () => {
    await createDeviceKey({ biometric: false });
    await expect(deviceSigner(REQUEST)).rejects.toThrow('not bound');
    await setDeviceId('d1');
    await expect(deviceSigner(REQUEST)).resolves.toMatchObject({ deviceId: 'd1' });
  });

  it('cannot sign after the key is deleted', async () => {
    await createDeviceKey({ biometric: false });
    await deleteDeviceKey();
    expect(await getDeviceKeyInfo()).toBeNull();
    await expect(signWithDeviceKey('x')).rejects.toThrow('no key');
  });
});
