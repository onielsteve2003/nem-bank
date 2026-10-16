import { CloudOff, RotateCw, TriangleAlert } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';

import { Button } from './Button';
import { EmptyState } from './EmptyState';

export type Props = {
  title?: string;
  message?: string;
  /** `offline` swaps in the no-connection icon and copy. */
  kind?: 'error' | 'offline';
  /** May return a promise; the button stays busy until it settles. */
  onRetry?: () => void | Promise<unknown>;
  retryLabel?: string;
};

const COPY = {
  error: {
    icon: TriangleAlert,
    title: 'Something went wrong',
    message: 'We couldn’t load this. Your money is safe.',
  },
  offline: {
    icon: CloudOff,
    title: 'You’re offline',
    message: 'Check your connection and try again.',
  },
} as const;

/** The error half of every data screen's loading/empty/error/success set. */
export function ErrorState({
  title,
  message,
  kind = 'error',
  onRetry,
  retryLabel = 'Try again',
}: Props) {
  const copy = COPY[kind];
  const [retrying, setRetrying] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const retry = async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry();
    } catch {
      // A failed retry keeps showing this state; the caller owns the error itself.
    } finally {
      // A successful retry usually unmounts this component before it settles.
      if (mounted.current) setRetrying(false);
    }
  };

  return (
    <EmptyState
      icon={copy.icon}
      tone="danger"
      title={title ?? copy.title}
      message={message ?? copy.message}
    >
      {onRetry && (
        <Button
          label={retryLabel}
          icon={RotateCw}
          variant="secondary"
          loading={retrying}
          onPress={() => void retry()}
          style={styles.action}
        />
      )}
    </EmptyState>
  );
}

const styles = StyleSheet.create({
  action: { alignSelf: 'center' },
});
