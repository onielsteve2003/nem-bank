import { fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '@/theme';

import { Checkbox } from './Checkbox';
import { SelectSheet } from './SelectSheet';
import { Switch } from './Switch';
import { TextField } from './TextField';

jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const renderThemed = (ui: React.ReactElement) =>
  render(
    <SafeAreaProvider initialMetrics={metrics}>
      <ThemeProvider initialPreference="dark">{ui}</ThemeProvider>
    </SafeAreaProvider>,
  );

describe('TextField', () => {
  it('is labelled, reports typing and blur, and shows help text', async () => {
    const onChangeText = jest.fn();
    const onBlur = jest.fn();
    await renderThemed(
      <TextField
        label="Email"
        help="We send a code here"
        onChangeText={onChangeText}
        onBlur={onBlur}
      />,
    );
    const input = screen.getByLabelText('Email');
    await fireEvent.changeText(input, 'ada@nem.bank');
    await fireEvent(input, 'blur');
    expect(onChangeText).toHaveBeenCalledWith('ada@nem.bank');
    expect(onBlur).toHaveBeenCalled();
    expect(screen.getByText('We send a code here')).toBeOnTheScreen();
  });

  it('announces an error in place of the help text', async () => {
    await renderThemed(<TextField label="Email" help="Help" error="Enter a valid email" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email');
    expect(screen.queryByText('Help')).toBeNull();
  });

  it('hides secure text until the reveal button is pressed', async () => {
    await renderThemed(<TextField label="Password" secureTextEntry />);
    expect(screen.getByLabelText('Password').props.secureTextEntry).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Show Password' }));
    expect(screen.getByLabelText('Password').props.secureTextEntry).toBe(false);
    expect(screen.getByRole('button', { name: 'Hide Password' })).toBeOnTheScreen();
  });
});

describe('SelectSheet', () => {
  function Harness({ onChange }: { onChange: (v: string) => void }) {
    const [value, setValue] = useState<'NGN' | 'USD' | null>(null);
    return (
      <SelectSheet
        label="Currency"
        value={value}
        options={[
          { value: 'NGN', label: 'Naira' },
          { value: 'USD', label: 'US Dollar' },
        ]}
        onChange={(v) => {
          setValue(v);
          onChange(v);
        }}
      />
    );
  }

  it('opens the options, selects one and shows it in the field', async () => {
    const onChange = jest.fn();
    await renderThemed(<Harness onChange={onChange} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Currency, not selected' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'US Dollar' }));
    expect(onChange).toHaveBeenCalledWith('USD');
    expect(screen.queryByRole('radio', { name: 'US Dollar' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Currency, US Dollar' })).toBeOnTheScreen();
  });
});

describe('Switch', () => {
  it('toggles from anywhere on the row and reports its state', async () => {
    const onValueChange = jest.fn();
    await renderThemed(
      <Switch label="Hide balances" value={false} onValueChange={onValueChange} />,
    );
    const row = screen.getByRole('switch', { name: 'Hide balances' });
    expect(row).not.toBeChecked();
    await fireEvent.press(row);
    expect(onValueChange).toHaveBeenCalledWith(true);
  });
});

describe('Checkbox', () => {
  it('toggles and exposes the checked state', async () => {
    const onChange = jest.fn();
    await renderThemed(<Checkbox label="I accept the terms" checked onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: 'I accept the terms' });
    expect(box).toBeChecked();
    await fireEvent.press(box);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('shows its error', async () => {
    await renderThemed(
      <Checkbox label="Terms" checked={false} onChange={jest.fn()} error="Accept to continue" />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Accept to continue');
  });
});
