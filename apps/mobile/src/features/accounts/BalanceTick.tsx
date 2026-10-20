import { formatMoney, isPositive, money, negate, subtract, type Money } from '@nem/shared';
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import Animated, { FadeInDown, FadeOut } from 'react-native-reanimated';

import { Text, type TextColor } from '@/components';

const SHOW_MS = 2_500;

/**
 * The change since the last amount this hook saw, kept for a moment after a
 * realtime update. Nothing on first render: a balance loading is not news.
 */
export function useBalanceDelta(value: Money): Money | null {
  const [prev, setPrev] = useState(value);
  const [delta, setDelta] = useState<Money | null>(null);
  if (prev.amount !== value.amount || prev.currency !== value.currency) {
    setPrev(value);
    setDelta(
      prev.currency === value.currency ? subtract(value, money(prev.amount, prev.currency)) : null,
    );
  }
  useEffect(() => {
    if (!delta) return;
    const timer = setTimeout(() => setDelta(null), SHOW_MS);
    return () => clearTimeout(timer);
  }, [delta]);
  return delta;
}

export type Props = {
  value: Money;
  hidden: boolean;
  color: TextColor;
  /** Spoken with the change, e.g. "Naira wallet". */
  label: string;
};

/**
 * "+₦5,000.00" that rises in beside a balance when it changes live (ACC-4),
 * then fades. Reanimated's layout animations follow the system reduce-motion
 * setting, and the change is announced so it is not only visual. In privacy
 * mode only the direction is shown.
 */
export function BalanceTick({ value, hidden, color, label }: Props) {
  const delta = useBalanceDelta(value);
  const up = delta ? isPositive(delta) : false;
  useEffect(() => {
    if (!delta) return;
    AccessibilityInfo.announceForAccessibility(
      hidden
        ? `${label} balance went ${up ? 'up' : 'down'}`
        : `${label} balance went ${up ? 'up' : 'down'} by ${formatMoney(up ? delta : negate(delta))}`,
    );
  }, [delta, hidden, label, up]);

  if (!delta || delta.amount === 0n) return null;
  return (
    <Animated.View entering={FadeInDown.duration(220)} exiting={FadeOut.duration(400)}>
      <Text variant="caption" color={color} importantForAccessibility="no">
        {hidden ? (up ? '▲ Money in' : '▼ Money out') : formatMoney(delta, { signPositive: true })}
      </Text>
    </Animated.View>
  );
}
