import { COLORS, DURATION, EASING } from '@nem/shared';
import { Nfc, Snowflake } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { StyleSheet, View, type TextStyle } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { haptic } from '@/lib/haptics';
import { useTheme } from '@/theme';

import { PressableScale } from '../PressableScale';
import { Text } from '../Text';
import { useDeviceTilt } from './useDeviceTilt';

// Card art is the same in both themes, like a physical card: Volt Noir's dark palette.
const INK = COLORS.dark;
/** ISO/IEC 7810 ID-1 card proportions. */
export const CARD_ASPECT = 85.6 / 53.98;
const FLIP_MS = DURATION.slow * 2;
const PERSPECTIVE = 900;

export type CardNetwork = 'verve' | 'visa' | 'mastercard';

const NETWORK_NAME: Record<CardNetwork, string> = {
  verve: 'Verve',
  visa: 'Visa',
  mastercard: 'Mastercard',
};

export type Props = {
  holder: string;
  last4: string;
  /** "MM/YY". */
  expiry: string;
  network: CardNetwork;
  kind?: 'virtual' | 'physical';
  frozen?: boolean;
  /** Full number and CVV for the back, only once the user has unlocked them; masked otherwise. */
  revealed?: { number: string; cvv: string };
  /** Tilt with the phone. Ignored with reduce motion. */
  tilt?: boolean;
  /** Controlled side; leave unset to let a tap flip the card. */
  flipped?: boolean;
  onFlip?: (flipped: boolean) => void;
};

/**
 * A bank card that flips in 3D on tap and tilts with the phone. With reduce motion
 * it does not tilt and the flip becomes a crossfade.
 */
export function BankCard({
  holder,
  last4,
  expiry,
  network,
  kind = 'virtual',
  frozen = false,
  revealed,
  tilt = true,
  flipped: controlled,
  onFlip,
}: Props) {
  const { radius } = useTheme();
  const reduceMotion = useReducedMotion();
  const [own, setOwn] = useState(false);
  const flipped = controlled ?? own;
  const device = useDeviceTilt(tilt && !reduceMotion);

  const flip = useDerivedValue(() =>
    withTiming(flipped ? 1 : 0, {
      duration: reduceMotion ? DURATION.base : FLIP_MS,
      easing: Easing.bezier(...EASING.standard),
    }),
  );

  // One worklet for both faces: the back is the front turned a further half turn.
  const faceStyle = (side: 0 | 1) => {
    'worklet';
    const shown = side === 0 ? 1 - flip.value : flip.value;
    if (reduceMotion) return { opacity: shown, transform: [] };
    const turn = interpolate(flip.value, [0, 1], [0, 180]) + side * 180;
    return {
      // Hard cut at the edge-on midpoint, for platforms that ignore backfaceVisibility.
      opacity: shown > 0.5 ? 1 : 0,
      transform: [
        { perspective: PERSPECTIVE },
        { rotateX: `${device.rotateX.value}deg` },
        { rotateY: `${turn + device.rotateY.value}deg` },
      ],
    };
  };
  const frontStyle = useAnimatedStyle(() => faceStyle(0));
  const backStyle = useAnimatedStyle(() => faceStyle(1));

  const name = `${kind === 'virtual' ? 'Virtual' : 'Physical'} ${NETWORK_NAME[network]} card ending ${last4}`;
  const toggle = () => {
    haptic('tap');
    setOwn(!flipped);
    onFlip?.(!flipped);
  };

  const faceBase = [styles.face, { borderRadius: radius.lg }];

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${name}, ${holder}, expires ${expiry}${frozen ? ', frozen' : ''}`}
      accessibilityHint={flipped ? 'Shows the front of the card' : 'Shows the back of the card'}
      accessibilityState={{ expanded: flipped }}
      onPress={toggle}
      style={styles.card}
    >
      <Animated.View
        style={[faceBase, frontStyle]}
        pointerEvents={flipped ? 'none' : 'auto'}
        importantForAccessibility="no-hide-descendants"
      >
        <CardArt />
        <View style={styles.row}>
          <Text variant="h3" style={ink('text')}>
            nem
          </Text>
          <Text variant="caption" style={ink('textMuted')}>
            {kind === 'virtual' ? 'VIRTUAL' : 'DEBIT'}
          </Text>
        </View>
        <View style={[styles.row, styles.chipRow]}>
          <View style={[styles.chip, { backgroundColor: INK.primary }]} />
          <Nfc size={22} color={INK.textMuted} aria-hidden />
        </View>
        <Text variant="amount" tabular style={ink('text')}>
          •••• •••• •••• {last4}
        </Text>
        <View style={styles.row}>
          <Labelled label="Card holder" value={holder.toUpperCase()} />
          <Labelled label="Expires" value={expiry} />
          <Text variant="title" style={[ink('text'), styles.network]}>
            {NETWORK_NAME[network]}
          </Text>
        </View>
        {frozen && <FrozenVeil />}
      </Animated.View>

      <Animated.View
        style={[faceBase, StyleSheet.absoluteFill, backStyle]}
        pointerEvents={flipped ? 'auto' : 'none'}
        importantForAccessibility="no-hide-descendants"
      >
        <CardArt />
        <View style={[styles.strip, { backgroundColor: INK.background }]} />
        <View style={styles.backBody}>
          <Labelled
            label="Card number"
            value={revealed ? groupPan(revealed.number) : `•••• •••• •••• ${last4}`}
          />
          <View style={styles.row}>
            <Labelled label="Expires" value={expiry} />
            <Labelled label="CVV" value={revealed ? revealed.cvv : '•••'} />
            <Text variant="caption" style={ink('textMuted')}>
              {revealed ? 'Hidden again when you leave' : 'Unlock to see details'}
            </Text>
          </View>
        </View>
        {frozen && <FrozenVeil />}
      </Animated.View>
    </PressableScale>
  );
}

const ink = (token: 'text' | 'textMuted'): TextStyle => ({ color: INK[token] });

/** "5399123412344821" → "5399 1234 1234 4821". */
export const groupPan = (pan: string): string =>
  pan
    .replace(/\D/g, '')
    .replace(/(.{4})/g, '$1 ')
    .trim();

function Labelled({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View>
      <Text variant="caption" style={ink('textMuted')}>
        {label}
      </Text>
      <Text variant="label" tabular style={ink('text')} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function CardArt() {
  return (
    <Svg style={StyleSheet.absoluteFill} preserveAspectRatio="none" viewBox="0 0 100 63">
      <Defs>
        <LinearGradient id="card-base" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={INK.raised} />
          <Stop offset="1" stopColor={INK.background} />
        </LinearGradient>
        <LinearGradient id="card-glow" x1="1" y1="0" x2="0.3" y2="0.8">
          <Stop offset="0" stopColor={INK.primary} stopOpacity={0.35} />
          <Stop offset="1" stopColor={INK.primary} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Rect width="100" height="63" fill="url(#card-base)" />
      <Rect width="100" height="63" fill="url(#card-glow)" />
    </Svg>
  );
}

function FrozenVeil() {
  return (
    <View style={[StyleSheet.absoluteFill, styles.veil, { backgroundColor: INK.overlay }]}>
      <Snowflake size={28} color={INK.info} aria-hidden />
      <Text variant="bodyStrong" style={ink('text')}>
        Frozen
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { width: '100%', aspectRatio: CARD_ASPECT },
  face: {
    flex: 1,
    padding: 20,
    justifyContent: 'space-between',
    overflow: 'hidden',
    backfaceVisibility: 'hidden',
  },
  row: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  chipRow: { alignItems: 'center' },
  chip: { width: 40, height: 30, borderRadius: 6, opacity: 0.9 },
  network: { fontStyle: 'italic' },
  strip: { height: 40, marginHorizontal: -20, marginTop: 4 },
  backBody: { gap: 12 },
  veil: { alignItems: 'center', justifyContent: 'center', gap: 6 },
});
