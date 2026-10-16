import { CircleAlert, CircleCheck, Info, type LucideIcon } from 'lucide-react-native';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeOutDown, SlideInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { haptic } from '@/lib/haptics';
import { useTheme } from '@/theme';

import { Icon } from './Icon';
import { Text } from './Text';

export type ToastTone = 'info' | 'success' | 'error';

export type ToastOptions = {
  message: string;
  tone?: ToastTone;
  /** An inline action, typically "Undo". Pressing it runs `onPress` and closes the toast. */
  action?: { label: string; onPress: () => void };
  duration?: number;
};

type ActiveToast = Required<Pick<ToastOptions, 'message' | 'tone' | 'duration'>> &
  Pick<ToastOptions, 'action'> & { id: number };

/** Short messages stay 4 s; toasts with an action stay longer so there is time to undo. */
export const TOAST_DURATION = { default: 4000, withAction: 6000 } as const;

const ICONS: Record<ToastTone, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  error: CircleAlert,
};

type ToastApi = { show: (options: ToastOptions) => void; hide: () => void };

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside <ToastProvider>');
  return api;
}

/** Hosts one toast at a time above the bottom safe area; a new toast replaces the current one. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ActiveToast | null>(null);
  const nextId = useRef(0);

  const hide = useCallback(() => setToast(null), []);

  const show = useCallback((options: ToastOptions) => {
    const tone = options.tone ?? 'info';
    nextId.current += 1;
    setToast({
      id: nextId.current,
      message: options.message,
      tone,
      action: options.action,
      duration:
        options.duration ?? (options.action ? TOAST_DURATION.withAction : TOAST_DURATION.default),
    });
    if (tone === 'error') haptic('error');
    else if (tone === 'success') haptic('success');
    // Toasts appear outside the focus order, so screen readers hear them announced.
    AccessibilityInfo.announceForAccessibility(
      options.action ? `${options.message}. ${options.action.label} available.` : options.message,
    );
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(hide, toast.duration);
    return () => clearTimeout(timer);
  }, [toast, hide]);

  const api = useMemo(() => ({ show, hide }), [show, hide]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        {toast && <ToastView key={toast.id} toast={toast} onDone={hide} />}
      </View>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, onDone }: { toast: ActiveToast; onDone: () => void }) {
  const { colors, radius, spacing, motion, elevation } = useTheme();
  const insets = useSafeAreaInsets();
  const toneColor = toast.tone === 'error' ? 'danger' : toast.tone;

  return (
    <Animated.View
      entering={SlideInDown.duration(motion.duration.base)}
      exiting={FadeOutDown.duration(motion.duration.fast)}
      accessibilityLiveRegion="polite"
      style={[
        styles.toast,
        elevation.medium,
        {
          bottom: insets.bottom + spacing[4],
          marginHorizontal: spacing[4],
          padding: spacing[3],
          paddingLeft: spacing[4],
          gap: spacing[3],
          borderRadius: radius.lg,
          backgroundColor: colors.raised,
          borderColor: colors.border,
        },
      ]}
    >
      <Icon icon={ICONS[toast.tone]} color={toneColor} />
      <Text variant="bodySmall" style={styles.flex}>
        {toast.message}
      </Text>
      {toast.action && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={toast.action.label}
          onPress={() => {
            haptic('tap');
            toast.action?.onPress();
            onDone();
          }}
          style={[styles.action, { paddingHorizontal: spacing[3], borderRadius: radius.pill }]}
        >
          <Text variant="label" color="primaryText">
            {toast.action.label}
          </Text>
        </Pressable>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  flex: { flex: 1 },
  action: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
});
