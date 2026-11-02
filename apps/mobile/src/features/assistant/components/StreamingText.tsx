import { useEffect, useState } from 'react';

import { Text } from '@/components';
import { useReduceMotion } from '@/lib/motion';

import { revealed } from '../assistant';

const TICK_MS = 30;

/**
 * A reply typing itself out word by word. Screen readers get the whole reply
 * at once, and with reduce motion on it simply appears.
 */
export function StreamingText({ text }: { text: string }) {
  const reduceMotion = useReduceMotion();
  const [elapsed, setElapsed] = useState(0);
  const shown = reduceMotion ? text : revealed(text, elapsed);
  const done = shown === text;

  useEffect(() => {
    if (done) return;
    const timer = setTimeout(() => setElapsed((e) => e + TICK_MS), TICK_MS);
    return () => clearTimeout(timer);
  }, [done, elapsed]);

  return (
    <Text variant="body" accessibilityLabel={text} accessibilityLiveRegion="polite" selectable>
      {shown}
    </Text>
  );
}
