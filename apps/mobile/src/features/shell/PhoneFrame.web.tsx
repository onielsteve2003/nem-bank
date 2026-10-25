import {
  Camera,
  CameraOff,
  Code,
  Fingerprint,
  KeyRound,
  Vibrate,
  type LucideIcon,
} from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState, type ReactNode, type ComponentRef } from 'react';
import { Linking, StyleSheet, useWindowDimensions, View } from 'react-native';

import { Button, Icon, Text } from '@/components';
import { FrameRectContext, type FrameRect } from '@/components/modalFrame';
import { getCameraSupport, type CameraSupport } from '@/lib/camera';
import { useTheme } from '@/theme';

import { PHONE_BEZEL, PHONE_SCREEN, frameLayout, type FrameLayout } from './frameLayout';

const REPO_URL = 'https://github.com/onielsteve2003/nem-bank';
/** Device hardware: the same near-black in both themes. */
const BEZEL_COLOR = '#05060A';

export function PhoneFrame({ children }: { children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  return <PhoneFrameLayout layout={frameLayout(width, height)}>{children}</PhoneFrameLayout>;
}

/**
 * The tree has the same shape in both modes, so resizing the window across the
 * breakpoint restyles the app instead of remounting it (navigation and forms survive).
 */
export function PhoneFrameLayout({
  layout,
  children,
}: {
  layout: FrameLayout;
  children: ReactNode;
}) {
  const { colors, spacing } = useTheme();
  const framed = layout.mode === 'frame';
  const screenRef = useRef<ComponentRef<typeof View>>(null);
  const [rect, setRect] = useState<FrameRect | null>(null);

  // Modals render outside the frame on web, so they need its place on the page.
  const measure = useCallback(() => {
    const node = screenRef.current as unknown as HTMLElement | null;
    if (!framed || typeof node?.getBoundingClientRect !== 'function') {
      setRect(null);
      return;
    }
    const box = node.getBoundingClientRect();
    setRect({
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      radius: PHONE_SCREEN.radius,
    });
  }, [framed]);

  // onLayout misses a frame that moves without resizing (the window widening), so remeasure on size changes too.
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  useEffect(() => {
    measure();
  }, [measure, windowWidth, windowHeight, layout]);

  return (
    <View style={[styles.page, framed && { backgroundColor: colors.raised, gap: spacing[16] }]}>
      {framed && layout.panel && <DemoPanel />}
      <View
        style={
          framed
            ? [
                styles.bezel,
                {
                  borderRadius: PHONE_SCREEN.radius + PHONE_BEZEL,
                  borderWidth: PHONE_BEZEL,
                },
              ]
            : styles.fill
        }
      >
        <View
          ref={screenRef}
          onLayout={measure}
          style={[
            framed
              ? {
                  width: layout.width,
                  height: layout.height,
                  borderRadius: PHONE_SCREEN.radius,
                  overflow: 'hidden',
                }
              : styles.fill,
            { backgroundColor: colors.background },
          ]}
        >
          <FrameRectContext.Provider value={rect}>{children}</FrameRectContext.Provider>
        </View>
      </View>
    </View>
  );
}

/** What a recruiter on a laptop should know: it is a demo, and what the browser cannot do. */
function DemoPanel() {
  const { spacing } = useTheme();
  const [camera, setCamera] = useState<CameraSupport | null>(null);

  useEffect(() => {
    let live = true;
    void getCameraSupport().then((support) => live && setCamera(support));
    return () => {
      live = false;
    };
  }, []);

  return (
    <View style={[styles.panel, { gap: spacing[3] }]} role="complementary">
      <Text variant="label" color="primaryText" style={styles.eyebrow}>
        Web demo
      </Text>
      <Text variant="display">Nem Bank</Text>
      <Text color="textMuted">
        A digital bank running on a simulated ledger inside this page. No real money moves, and
        nothing you enter leaves your browser.
      </Text>
      <View style={{ gap: spacing[3], marginTop: spacing[4] }}>
        <Text variant="bodyStrong">In the browser</Text>
        <Limit
          icon={Fingerprint}
          text="No Face ID or fingerprint: the app unlocks with your PIN."
        />
        <Limit
          icon={KeyRound}
          text="No secure keychain: your session is kept for this tab only and ends when you close it."
        />
        {camera && (
          <Limit
            icon={camera === 'browser' ? Camera : CameraOff}
            text={
              camera === 'browser'
                ? 'QR scanning asks to use your browser camera.'
                : 'No camera found: pay links still work.'
            }
          />
        )}
        <Limit
          icon={Vibrate}
          text="No haptics, and screenshots of card details cannot be blocked."
        />
      </View>
      <Text variant="bodySmall" color="textMuted" style={{ marginTop: spacing[4] }}>
        For the full experience, open it on a phone with Expo Go.
      </Text>
      <Button
        label="Source on GitHub"
        variant="secondary"
        size="sm"
        icon={Code}
        onPress={() => void Linking.openURL(REPO_URL)}
        style={styles.link}
      />
    </View>
  );
}

function Limit({ icon, text }: { icon: LucideIcon; text: string }) {
  const { spacing } = useTheme();
  return (
    <View style={[styles.limit, { gap: spacing[3] }]}>
      <Icon icon={icon} size="sm" color="textMuted" />
      <Text variant="bodySmall" style={styles.flex}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1, alignSelf: 'stretch' },
  bezel: { borderColor: BEZEL_COLOR, boxShadow: '0 30px 80px rgba(0, 0, 0, 0.35)' },
  panel: { width: 360 },
  eyebrow: { letterSpacing: 2, textTransform: 'uppercase' },
  limit: { flexDirection: 'row', alignItems: 'flex-start' },
  flex: { flex: 1 },
  link: { alignSelf: 'flex-start' },
});
