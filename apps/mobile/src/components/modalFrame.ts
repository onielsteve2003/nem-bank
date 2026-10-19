import { createContext, useContext } from 'react';
import type { ViewStyle } from 'react-native';

/** Where the app is drawn on the page when the web demo shows it in a phone frame (T4.8). */
export interface FrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
}

export const FrameRectContext = createContext<FrameRect | null>(null);

/**
 * On web the core `Modal` renders at the root of the page, outside the phone
 * frame. Its backdrop takes this style so dialogs and sheets stay inside the
 * frame. Null when the app fills the screen (phones, narrow browsers).
 */
export function useModalFrameStyle(): ViewStyle | null {
  const rect = useContext(FrameRectContext);
  if (!rect) return null;
  return {
    position: 'absolute',
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    borderRadius: rect.radius,
    overflow: 'hidden',
  };
}
