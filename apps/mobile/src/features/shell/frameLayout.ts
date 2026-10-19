// The web demo on a wide screen: the app sits in a phone-sized frame (an iPhone
// 15-sized screen) instead of stretching across a monitor (T4.8).

export const PHONE_SCREEN = { width: 390, height: 844, radius: 44 } as const;
export const PHONE_BEZEL = 10;
/** Space kept between the frame and the window edge. */
export const FRAME_MARGIN = 24;
/** Narrower than this the browser is a phone or a small tablet: the app fills it. */
export const FRAME_MIN_WIDTH = 720;
/** Shorter than this a frame would be too cramped to use. */
export const FRAME_MIN_HEIGHT = 560;
/** Wide enough for the "about this demo" panel beside the frame. */
export const PANEL_MIN_WIDTH = 1080;

export type FrameLayout =
  { mode: 'fill' } | { mode: 'frame'; width: number; height: number; panel: boolean };

export function frameLayout(windowWidth: number, windowHeight: number): FrameLayout {
  if (windowWidth < FRAME_MIN_WIDTH || windowHeight < FRAME_MIN_HEIGHT) return { mode: 'fill' };
  const room = windowHeight - 2 * (FRAME_MARGIN + PHONE_BEZEL);
  return {
    mode: 'frame',
    width: PHONE_SCREEN.width,
    height: Math.min(PHONE_SCREEN.height, room),
    panel: windowWidth >= PANEL_MIN_WIDTH,
  };
}
