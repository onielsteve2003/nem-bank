import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Inbox } from 'lucide-react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '@/theme';

import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { Screen } from './Screen';
import { Skeleton, SkeletonGroup } from './Skeleton';
import { Text } from './Text';

jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const renderThemed = (ui: React.ReactElement) =>
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider initialPreference="dark">{ui}</ThemeProvider>
    </SafeAreaProvider>,
  );

describe('Skeleton', () => {
  it('announces a group once as busy and hides the blocks', async () => {
    await renderThemed(
      <SkeletonGroup accessibilityLabel="Loading transactions">
        <Skeleton />
        <Skeleton circle height={40} />
      </SkeletonGroup>,
    );
    expect(screen.getByLabelText('Loading transactions')).toBeBusy();
  });
});

describe('EmptyState', () => {
  it('shows its title as a header and runs its action', async () => {
    const onAction = jest.fn();
    await renderThemed(
      <EmptyState
        icon={Inbox}
        title="No transactions yet"
        actionLabel="Add money"
        onAction={onAction}
      />,
    );
    expect(screen.getByRole('header', { name: 'No transactions yet' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Add money' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});

describe('ErrorState', () => {
  it('uses offline copy for offline errors', async () => {
    await renderThemed(<ErrorState kind="offline" />);
    expect(screen.getByText('You’re offline')).toBeOnTheScreen();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('stays busy until the retry settles, and recovers after a failed retry', async () => {
    let fail!: (e: Error) => void;
    const onRetry = jest.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    await renderThemed(<ErrorState onRetry={onRetry} />);

    const button = screen.getByRole('button', { name: 'Try again' });
    await fireEvent.press(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(button).toBeBusy();

    await act(async () => fail(new Error('still down')));
    expect(screen.getByRole('button', { name: 'Try again' })).not.toBeBusy();
  });
});

describe('Screen', () => {
  it('renders header, content and footer', async () => {
    await renderThemed(
      <Screen header={<Text>Title</Text>} footer={<Text>Continue</Text>}>
        <Text>Body</Text>
      </Screen>,
    );
    for (const t of ['Title', 'Body', 'Continue']) expect(screen.getByText(t)).toBeOnTheScreen();
  });

  it('wires pull to refresh only when onRefresh is given', async () => {
    const onRefresh = jest.fn();
    const { rerender } = await renderThemed(
      <Screen>
        <Text>Body</Text>
      </Screen>,
    );
    expect(screen.getByTestId('screen-scroll').props.refreshControl).toBeUndefined();

    await rerender(
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider initialPreference="dark">
          <Screen onRefresh={onRefresh} refreshing>
            <Text>Body</Text>
          </Screen>
        </ThemeProvider>
      </SafeAreaProvider>,
    );
    // The Jest RefreshControl mock drops its props, so read them off the scroll view.
    const control = screen.getByTestId('screen-scroll').props.refreshControl;
    expect(control.props.refreshing).toBe(true);
    control.props.onRefresh();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
