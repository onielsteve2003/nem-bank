import { fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider } from '@/theme';

import { Slider } from './Slider';

jest.mock('@/lib/haptics', () => ({ haptic: jest.fn() }));

const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function Months({ onChange }: { onChange: (v: number) => void }) {
  const [value, setValue] = useState(1);
  return (
    <Slider
      label="Repay over"
      value={value}
      steps={3}
      valueText={`${value + 1} months`}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

describe('Slider', () => {
  it('is adjustable with VoiceOver one step at a time and stops at the ends', async () => {
    const onChange = jest.fn();
    await render(
      <SafeAreaProvider initialMetrics={metrics}>
        <ThemeProvider initialPreference="dark">
          <Months onChange={onChange} />
        </ThemeProvider>
      </SafeAreaProvider>,
    );
    const slider = screen.getByRole('adjustable', { name: 'Repay over' });
    expect(slider.props.accessibilityValue).toEqual({ text: '2 months' });
    await fireEvent(slider, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(onChange).toHaveBeenLastCalledWith(2);
    await fireEvent(slider, 'accessibilityAction', { nativeEvent: { actionName: 'increment' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    await fireEvent(slider, 'accessibilityAction', { nativeEvent: { actionName: 'decrement' } });
    expect(onChange).toHaveBeenLastCalledWith(1);
  });
});
