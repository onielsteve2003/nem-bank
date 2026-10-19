// Every phone running Expo Go has a camera; access itself comes with expo-camera
// and its permission prompt (T7.11). The web demo checks the browser (camera.web.ts).

/** `device`: the phone camera. `browser`: getUserMedia. `none`: no camera, use links or typed codes. */
export type CameraSupport = 'device' | 'browser' | 'none';

export async function getCameraSupport(): Promise<CameraSupport> {
  return 'device';
}
