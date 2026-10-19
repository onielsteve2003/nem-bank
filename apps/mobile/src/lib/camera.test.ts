import { getCameraSupport } from './camera.web';

type Device = { kind: string };

function browser({ secure = true, devices = [] as Device[], media = true } = {}) {
  Object.defineProperty(globalThis, 'isSecureContext', { value: secure, configurable: true });
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: media
      ? { getUserMedia: jest.fn(), enumerateDevices: jest.fn().mockResolvedValue(devices) }
      : undefined,
    configurable: true,
  });
}

describe('getCameraSupport (web)', () => {
  it('uses the browser camera on a secure page with a webcam', async () => {
    browser({ devices: [{ kind: 'audioinput' }, { kind: 'videoinput' }] });
    await expect(getCameraSupport()).resolves.toBe('browser');
  });

  it('reports none without a webcam, on plain http, or without getUserMedia', async () => {
    browser({ devices: [{ kind: 'audioinput' }] });
    await expect(getCameraSupport()).resolves.toBe('none');
    browser({ secure: false, devices: [{ kind: 'videoinput' }] });
    await expect(getCameraSupport()).resolves.toBe('none');
    browser({ media: false });
    await expect(getCameraSupport()).resolves.toBe('none');
  });

  it('never throws when listing devices fails', async () => {
    browser();
    (globalThis.navigator.mediaDevices.enumerateDevices as jest.Mock).mockRejectedValue(
      new Error('blocked'),
    );
    await expect(getCameraSupport()).resolves.toBe('none');
  });
});
