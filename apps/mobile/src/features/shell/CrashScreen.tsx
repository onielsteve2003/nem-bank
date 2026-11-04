import { House, RotateCw, TriangleAlert } from '@/components/icons';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { Button, EmptyState, Screen, Text } from '@/components';
import { useTheme } from '@/theme';

export type Props = {
  error: Error;
  retry: () => void | Promise<void>;
  /** Leaves the broken screen for Home; absent when the router itself is gone. */
  onHome?: () => void;
};

/** Where a crash is reported. Dev logs it; Sentry (T22.8) takes over in production. */
export function reportCrash(error: Error, info?: ErrorInfo): void {
  if (__DEV__) console.error('[crash]', error, info?.componentStack);
}

/**
 * What the user sees instead of a white screen when a screen throws. It says
 * plainly that their money is safe, because a crash in a bank app reads as
 * "did my transfer go through?". Unsent forms are lost; nothing is charged.
 */
export function CrashScreen({ error, retry, onHome }: Props) {
  const { spacing } = useTheme();
  const { t } = useTranslation();
  return (
    <Screen>
      <EmptyState
        icon={TriangleAlert}
        tone="danger"
        title={t('errors.crashTitle')}
        message={t('errors.crashMessage')}
      >
        <View style={[styles.actions, { gap: spacing[3], marginTop: spacing[2] }]}>
          <Button label={t('common.tryAgain')} icon={RotateCw} onPress={() => void retry()} />
          {onHome && (
            <Button label={t('common.goHome')} icon={House} variant="secondary" onPress={onHome} />
          )}
        </View>
        {__DEV__ && (
          <Text variant="caption" color="textMuted" align="center" selectable>
            {error.message}
          </Text>
        )}
      </EmptyState>
    </Screen>
  );
}

type BoundaryProps = { children: ReactNode };
type BoundaryState = { error: Error | null };

/**
 * The last line of defence, around the whole navigator: catches what a route's
 * own boundary cannot, such as a crash in a provider or a layout.
 */
export class AppErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    reportCrash(error, info);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <CrashScreen error={error} retry={() => this.setState({ error: null })} />;
  }
}

const styles = StyleSheet.create({
  actions: { alignSelf: 'stretch' },
});
