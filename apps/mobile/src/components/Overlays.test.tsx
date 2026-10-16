import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '@/theme';

import { Button } from './Button';
import { Dialog } from './Dialog';
import { TOAST_DURATION, ToastProvider, useToast, type ToastOptions } from './Toast';

jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const renderThemed = (ui: React.ReactElement) =>
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider initialPreference="dark">
        <ToastProvider>{ui}</ToastProvider>
      </ThemeProvider>
    </SafeAreaProvider>,
  );

function Trigger({ options }: { options: ToastOptions }) {
  const toast = useToast();
  return <Button label="Trigger" onPress={() => toast.show(options)} />;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
});
afterEach(() => jest.useRealTimers());

describe('Toast', () => {
  it('shows, announces and hides itself after its duration', async () => {
    await renderThemed(<Trigger options={{ message: 'Saved' }} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Trigger' }));
    expect(screen.getByText('Saved')).toBeOnTheScreen();
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Saved');

    await act(() => jest.advanceTimersByTime(TOAST_DURATION.default));
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('runs the undo action once and closes', async () => {
    const undo = jest.fn();
    await renderThemed(
      <Trigger
        options={{ message: 'Beneficiary removed', action: { label: 'Undo', onPress: undo } }}
      />,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Trigger' }));
    // Toasts with an action outlive plain ones so there is time to undo.
    await act(() => jest.advanceTimersByTime(TOAST_DURATION.default));
    await fireEvent.press(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Beneficiary removed')).toBeNull();
  });

  it('replaces the current toast with a new one', async () => {
    function Two() {
      const toast = useToast();
      return (
        <>
          <Button label="First" onPress={() => toast.show({ message: 'One' })} />
          <Button label="Second" onPress={() => toast.show({ message: 'Two' })} />
        </>
      );
    }
    await renderThemed(<Two />);
    await fireEvent.press(screen.getByRole('button', { name: 'First' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Second' }));
    expect(screen.queryByText('One')).toBeNull();
    expect(screen.getByText('Two')).toBeOnTheScreen();
  });

  it('throws a clear error outside the provider', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      render(
        <ThemeProvider>
          <Trigger options={{ message: 'x' }} />
        </ThemeProvider>,
      ),
    ).rejects.toThrow('useToast must be used inside <ToastProvider>');
  });
});

describe('Dialog', () => {
  const props = {
    open: true,
    title: 'Freeze this card?',
    confirmLabel: 'Freeze card',
    onConfirm: jest.fn(),
    onCancel: jest.fn(),
  };

  beforeEach(() => jest.clearAllMocks());

  it('confirms and cancels', async () => {
    await renderThemed(<Dialog {...props} destructive />);
    await fireEvent.press(screen.getByRole('button', { name: 'Freeze card' }));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getAllByRole('button', { name: 'Cancel' }).at(-1)!);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('cannot be cancelled while the action is running', async () => {
    await renderThemed(<Dialog {...props} loading />);
    for (const cancel of screen.getAllByRole('button', { name: 'Cancel' })) {
      await fireEvent.press(cancel);
    }
    expect(props.onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Freeze card' })).toBeBusy();
  });
});
