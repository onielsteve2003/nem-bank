import { CURRENCIES, formatMoney, zero, type Money, type TypeVariant } from '@nem/shared';
import { useEffect, useRef, useState } from 'react';
import type { TextStyle } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { easeOutCubic, interpolateMoney } from './moneyTween';
import { Text, type TextColor } from './Text';

/** Count-up length. Longer than the 300 ms UI motion cap on purpose: digits need time to read as counting. */
export const COUNT_UP_MS = 700;
export const MASK = '••••••';

export type Props = {
  value: Money;
  variant?: TypeVariant;
  color?: TextColor;
  /** Colours credits success and debits danger, e.g. in transaction lists. Overrides `color`. */
  colorBySign?: boolean;
  /** Privacy mask: shows "₦••••••" and is announced as hidden. */
  masked?: boolean;
  /** Counts up from zero on mount, then from the shown amount whenever `value` changes. Off with reduce motion. */
  animate?: boolean;
  signPositive?: boolean;
  trimZeroMinor?: boolean;
  /** Prefix for the spoken label, e.g. "Available balance". */
  label?: string;
  align?: TextStyle['textAlign'];
  style?: TextStyle;
};

/** Screen readers say "minus" for a leading hyphen inconsistently, so spell it out. */
export function spokenMoney(text: string): string {
  return text.startsWith('-') ? `minus ${text.slice(1)}` : text;
}

export function MoneyText({
  value,
  variant = 'amount',
  color = 'text',
  colorBySign = false,
  masked = false,
  animate = false,
  signPositive = false,
  trimZeroMinor = false,
  label,
  align,
  style,
}: Props) {
  const reduceMotion = useReducedMotion();
  const tween = animate && !reduceMotion && !masked;
  const [shown, setShown] = useState<Money>(() => (tween ? zero(value.currency) : value));
  // Where the next count starts: the amount on screen, even mid-count.
  const fromRef = useRef(shown);

  useEffect(() => {
    if (!tween) {
      fromRef.current = value;
      return;
    }
    const from = fromRef.current;
    const start = Date.now();
    let frame = 0;
    const tick = () => {
      const t = (Date.now() - start) / COUNT_UP_MS;
      const next = interpolateMoney(from, value, easeOutCubic(t));
      fromRef.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // Restart only when the amount itself changes, not on a new object with the same value.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- value is tracked by amount + currency below
  }, [value.amount, value.currency, tween]);

  const options = { signPositive, trimZeroMinor };
  const finalText = formatMoney(value, options);
  const text = masked
    ? `${CURRENCIES[value.currency].symbol}${MASK}`
    : formatMoney(tween ? shown : value, options);
  const spoken = masked ? 'hidden' : spokenMoney(finalText);
  const tint: TextColor = colorBySign
    ? value.amount > 0n
      ? 'success'
      : value.amount < 0n
        ? 'danger'
        : color
    : color;

  return (
    <Text
      variant={variant}
      color={tint}
      align={align}
      tabular
      numberOfLines={1}
      adjustsFontSizeToFit
      // The label is always the final amount, so a screen reader never reads a mid-count value.
      accessibilityLabel={label ? `${label}, ${spoken}` : spoken}
      style={style}
    >
      {text}
    </Text>
  );
}
