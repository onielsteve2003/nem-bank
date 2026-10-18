import * as ScreenCapture from 'expo-screen-capture';
import { useEffect, useId } from 'react';

/**
 * Blocks screenshots and screen recording while a sensitive screen (PIN entry,
 * card details) is mounted. Android blanks captures and the app-switcher
 * thumbnail; iOS blanks recordings. Each caller passes its own key, so one
 * screen closing never lifts another's block. Unsupported devices are ignored.
 */
export function useSecureScreen(active = true): void {
  const key = useId();
  useEffect(() => {
    if (!active) return;
    ScreenCapture.preventScreenCaptureAsync(key).catch(() => undefined);
    return () => {
      ScreenCapture.allowScreenCaptureAsync(key).catch(() => undefined);
    };
  }, [active, key]);
}
