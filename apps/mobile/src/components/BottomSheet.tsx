import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

import { IconButton } from './IconButton';
import { Text } from './Text';

export type Props = {
  open: boolean;
  /** Called after the sheet is dismissed, by swipe, backdrop tap or the close button. */
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Fixed snap points such as ['50%', '90%']; by default the sheet fits its content. */
  snapPoints?: (string | number)[];
  /** Hides the close button for sheets that must be answered (the backdrop still closes it). */
  hideCloseButton?: boolean;
};

/**
 * Controlled wrapper around @gorhom/bottom-sheet's modal sheet: themed surface,
 * dimmed backdrop, safe-area padding and a labelled close button so the swipe
 * gesture always has a tap alternative (code-standards §7). It follows the
 * system reduce-motion setting by default.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  children,
  snapPoints,
  hideCloseButton = false,
}: Props) {
  const ref = useRef<BottomSheetModal>(null);
  const { colors, radius, spacing } = useTheme();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (open) ref.current?.present();
    else ref.current?.dismiss();
  }, [open]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
        opacity={1}
        style={[props.style, { backgroundColor: colors.overlay }]}
        accessibilityLabel="Close sheet"
      />
    ),
    [colors.overlay],
  );

  return (
    <BottomSheetModal
      ref={ref}
      onDismiss={onClose}
      snapPoints={snapPoints}
      enableDynamicSizing={!snapPoints}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: colors.surface, borderRadius: radius.xl }}
      handleIndicatorStyle={{ backgroundColor: colors.border }}
      accessible={false}
    >
      <BottomSheetScrollView
        accessibilityViewIsModal
        contentContainerStyle={{
          paddingHorizontal: spacing[4],
          paddingBottom: insets.bottom + spacing[4],
          gap: spacing[3],
        }}
      >
        {(title || !hideCloseButton) && (
          <View style={styles.header}>
            {title ? (
              <Text variant="h3" style={styles.flex}>
                {title}
              </Text>
            ) : (
              <View style={styles.flex} />
            )}
            {!hideCloseButton && (
              <IconButton
                icon={X}
                accessibilityLabel="Close"
                variant="ghost"
                onPress={() => ref.current?.dismiss()}
              />
            )}
          </View>
        )}
        {children}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
