import { fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';

import { haptic } from '@/lib/haptics';
import { ThemeProvider } from '@/theme';

import { AmountInput } from './AmountInput';
import { NumericKeypad } from './NumericKeypad';
import { OtpInput } from './OtpInput';
import { PinPad } from './PinPad';

jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

const renderThemed = (ui: React.ReactElement) =>
  render(<ThemeProvider initialPreference="dark">{ui}</ThemeProvider>);

const tap = async (...labels: string[]) => {
  for (const name of labels) await fireEvent.press(screen.getByRole('button', { name }));
};

beforeEach(() => jest.clearAllMocks());

describe('NumericKeypad', () => {
  it('sends digits, delete, and clear on a long press of delete', async () => {
    const onKey = jest.fn();
    await renderThemed(<NumericKeypad onKey={onKey} />);
    await tap('7', 'Delete');
    await fireEvent(screen.getByRole('button', { name: 'Delete' }), 'longPress');
    expect(onKey.mock.calls).toEqual([['7'], ['backspace'], ['clear']]);
    expect(screen.queryByRole('button', { name: 'Decimal point' })).toBeNull();
  });
});

describe('AmountInput', () => {
  function Harness() {
    const [value, setValue] = useState('');
    return <AmountInput currency="NGN" value={value} onChangeValue={setValue} />;
  }

  it('shows the typed amount grouped with the currency symbol', async () => {
    await renderThemed(<Harness />);
    expect(screen.getByLabelText('Amount: 0 Nigerian Naira')).toBeOnTheScreen();
    await tap('1', '5', '0', '0', 'Decimal point', '5');
    expect(screen.getByText('₦1,500.5')).toBeOnTheScreen();
  });

  it('rejects a third decimal with a warning haptic', async () => {
    await renderThemed(<Harness />);
    await tap('2', 'Decimal point', '5', '0');
    jest.clearAllMocks();
    await tap('1');
    expect(screen.getByText('₦2.50')).toBeOnTheScreen();
    expect(haptic).toHaveBeenCalledWith('warning');
  });
});

describe('PinPad', () => {
  it('submits the PIN once all digits are in', async () => {
    const onComplete = jest.fn().mockResolvedValue(true);
    await renderThemed(<PinPad title="Enter PIN" onComplete={onComplete} />);
    await tap('1', '3', '5', '7');
    expect(onComplete).toHaveBeenCalledWith('1357');
    expect(haptic).toHaveBeenCalledWith('success');
  });

  it('clears and buzzes when the PIN is rejected', async () => {
    const onComplete = jest.fn().mockResolvedValue(false);
    await renderThemed(
      <PinPad title="Enter PIN" onComplete={onComplete} error="Wrong PIN. 4 tries left" />,
    );
    await tap('1', '1', '2', '2');
    expect(haptic).toHaveBeenCalledWith('error');
    expect(screen.getByLabelText('0 of 4 digits entered')).toBeOnTheScreen();
    expect(screen.getByRole('alert')).toHaveTextContent('Wrong PIN. 4 tries left');
  });
});

describe('OtpInput', () => {
  function Harness({ onComplete }: { onComplete: (code: string) => void }) {
    const [code, setCode] = useState('');
    return <OtpInput value={code} onChangeText={setCode} onComplete={onComplete} />;
  }

  it('fills every cell from a pasted message and completes', async () => {
    const onComplete = jest.fn();
    await renderThemed(<Harness onComplete={onComplete} />);
    await fireEvent.changeText(
      screen.getByLabelText('Verification code, 6 digits'),
      'Your Nem code is 482 913',
    );
    expect(onComplete).toHaveBeenCalledWith('482913');
    expect(screen.getByLabelText('Verification code, 6 digits').props.value).toBe('482913');
  });

  it('does not complete until the last digit', async () => {
    const onComplete = jest.fn();
    await renderThemed(<Harness onComplete={onComplete} />);
    await fireEvent.changeText(screen.getByLabelText('Verification code, 6 digits'), '48291');
    expect(onComplete).not.toHaveBeenCalled();
  });
});
