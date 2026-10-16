import { fireEvent, render, screen } from '@testing-library/react-native';
import { ArrowRight, X } from 'lucide-react-native';

import { haptic } from '@/lib/haptics';
import { ThemeProvider } from '@/theme';

import { Button } from './Button';
import { IconButton } from './IconButton';

jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

const renderThemed = (ui: React.ReactElement) =>
  render(<ThemeProvider initialPreference="dark">{ui}</ThemeProvider>);

beforeEach(() => jest.clearAllMocks());

describe('Button', () => {
  it('presses with a light tap haptic', async () => {
    const onPress = jest.fn();
    await renderThemed(<Button label="Continue" icon={ArrowRight} onPress={onPress} />);
    fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(haptic).toHaveBeenCalledWith('tap');
  });

  it('warns with a haptic on danger buttons', async () => {
    await renderThemed(<Button label="Freeze card" variant="danger" onPress={jest.fn()} />);
    fireEvent.press(screen.getByRole('button', { name: 'Freeze card' }));
    expect(haptic).toHaveBeenCalledWith('warning');
  });

  it('ignores presses while disabled', async () => {
    const onPress = jest.fn();
    await renderThemed(<Button label="Send" disabled onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Send' });
    fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
  });

  it('shows a spinner, reports busy and blocks presses while loading', async () => {
    const onPress = jest.fn();
    await renderThemed(<Button label="Send" loading onPress={onPress} />);
    const button = screen.getByRole('button', { name: 'Send' });
    fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
    expect(button).toBeBusy();
    expect(screen.getByTestId('button-spinner')).toBeOnTheScreen();
  });

  it('extends small buttons to a 44 pt touch target', async () => {
    await renderThemed(<Button label="Edit" size="sm" />);
    expect(screen.getByRole('button', { name: 'Edit' }).props.hitSlop).toMatchObject({
      top: 4,
      bottom: 4,
    });
  });
});

describe('IconButton', () => {
  it('is announced by its label and presses with a haptic', async () => {
    const onPress = jest.fn();
    await renderThemed(<IconButton icon={X} accessibilityLabel="Close" onPress={onPress} />);
    fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(haptic).toHaveBeenCalledWith('tap');
  });

  it('can opt out of haptics', async () => {
    await renderThemed(
      <IconButton icon={X} accessibilityLabel="Close" haptic={false} onPress={jest.fn()} />,
    );
    fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    expect(haptic).not.toHaveBeenCalled();
  });
});
