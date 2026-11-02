import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ComponentRef,
  type RefObject,
} from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets, type Edge } from 'react-native-safe-area-context';

import { useTheme } from '@/theme';

export type Props = {
  children: ReactNode;
  /** Fixed above the content, e.g. a back button and title. */
  header?: ReactNode;
  /** Pinned below the content and lifted with the keyboard, e.g. a Continue button. */
  footer?: ReactNode;
  /** `false` for screens that manage their own list (FlashList) or fill the viewport. */
  scroll?: boolean;
  /** Adds the standard 16 pt gutter and section gap. */
  padded?: boolean;
  /** Enables pull to refresh on scrolling screens. */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Safe-area edges to inset; tab screens drop 'bottom' because the tab bar covers it. */
  edges?: Edge[];
  contentContainerStyle?: StyleProp<ViewStyle>;
};

/**
 * App-wide content shown at the top of every screen, under the status bar: the
 * shell puts the offline banner here, so components never read app state.
 */
const ScreenBannerContext = createContext<ReactNode>(null);
export const ScreenBannerProvider = ScreenBannerContext.Provider;

/**
 * Wraps screens shown as an iOS full-screen modal. There the native safe area
 * view can report no top inset, which put the header under the clock and
 * battery icons, so the top gap comes from the window's own insets instead.
 */
const FullScreenModalContext = createContext(false);
export const FullScreenModalProvider = ({ children }: { children: ReactNode }) => (
  <FullScreenModalContext.Provider value>{children}</FullScreenModalContext.Provider>
);

/**
 * How far the screen sits below the top of the window. KeyboardAvoidingView
 * measures itself against its parent, so inside an iOS sheet (which starts
 * lower down) it would lift the content too little and the keyboard would
 * cover the field. Measured as the keyboard opens, when the sheet has settled.
 */
function useSheetOffset(root: RefObject<ComponentRef<typeof View> | null>): number {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const sub = Keyboard.addListener('keyboardWillShow', () =>
      root.current?.measureInWindow((_x, y) => setOffset(Math.max(0, Math.round(y)))),
    );
    return () => sub.remove();
  }, [root]);
  return offset;
}

/** The shell every screen renders in: themed background, safe areas, keyboard avoiding, refresh. */
export function Screen({
  children,
  header,
  footer,
  scroll = true,
  padded = true,
  onRefresh,
  refreshing = false,
  edges = ['top', 'bottom'],
  contentContainerStyle,
}: Props) {
  const { colors, spacing } = useTheme();
  const banner = useContext(ScreenBannerContext);
  const root = useRef<ComponentRef<typeof View>>(null);
  const keyboardOffset = useSheetOffset(root);
  const insets = useSafeAreaInsets();
  const fullScreenModal = useContext(FullScreenModalContext);
  const padTop = fullScreenModal && edges.includes('top');
  const padding = padded ? { padding: spacing[4], gap: spacing[6] } : undefined;

  const body = scroll ? (
    <ScrollView
      testID="screen-scroll"
      style={styles.flex}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={[padding, contentContainerStyle]}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primaryText}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surface}
          />
        ) : undefined
      }
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, padding, contentContainerStyle]}>{children}</View>
  );

  return (
    <SafeAreaView
      ref={root}
      edges={padTop ? edges.filter((e) => e !== 'top') : edges}
      style={[
        styles.flex,
        { backgroundColor: colors.background },
        padTop && { paddingTop: insets.top },
      ]}
    >
      {banner}
      {header}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={keyboardOffset}
      >
        {body}
        {footer && (
          <View style={{ paddingHorizontal: spacing[4], paddingVertical: spacing[3] }}>
            {footer}
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
