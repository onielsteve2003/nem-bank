import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

/**
 * Wrap the layout of any flow presented as a modal (send, convert, KYC…) in
 * this. On iOS a modal is a separate native window above the root, so sheets
 * hosted by the root provider would open behind it and gestures would not
 * reach them. This gives the modal its own gesture root and sheet host.
 */
export function ModalSheetHost({ children }: { children: ReactNode }) {
  return (
    <GestureHandlerRootView style={styles.fill}>
      <BottomSheetModalProvider>{children}</BottomSheetModalProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
