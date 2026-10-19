import type { CameraSupport } from './camera';

export type { CameraSupport } from './camera';

/**
 * Browsers expose the camera through getUserMedia, only on secure pages (https
 * or localhost). Listing devices needs no permission, so a laptop without a
 * webcam is known before anything asks. Never throws.
 */
export async function getCameraSupport(): Promise<CameraSupport> {
  try {
    const media = globalThis.navigator?.mediaDevices;
    if (!globalThis.isSecureContext || typeof media?.getUserMedia !== 'function') return 'none';
    const devices = await media.enumerateDevices();
    return devices.some((device) => device.kind === 'videoinput') ? 'browser' : 'none';
  } catch {
    return 'none';
  }
}
