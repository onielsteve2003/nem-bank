import type { ReactNode } from 'react';

/** Phones draw the app edge to edge. The web demo frames it on wide screens (PhoneFrame.web.tsx). */
export function PhoneFrame({ children }: { children: ReactNode }) {
  return children;
}
