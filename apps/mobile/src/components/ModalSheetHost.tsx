import { createContext, useContext, type ReactNode } from 'react';

const InModalFlow = createContext(false);

/** True inside a flow presented as a native modal (see ModalSheetHost). */
export const useInModalFlow = () => useContext(InModalFlow);

/**
 * Wrap the layout of any flow presented as a modal (send, convert, KYC…) in
 * this. On iOS such a flow is its own native window above the app root, and
 * sheets hosted by @gorhom/bottom-sheet's root provider never show over it.
 * Inside this host, BottomSheet draws with the core `Modal` instead, which iOS
 * always presents on top.
 */
export function ModalSheetHost({ children }: { children: ReactNode }) {
  return <InModalFlow.Provider value>{children}</InModalFlow.Provider>;
}
