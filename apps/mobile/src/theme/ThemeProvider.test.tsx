import { COLORS } from '@nem/shared';
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { resolveScheme, ThemeProvider, type Theme } from './ThemeProvider';
import { useTheme } from './useTheme';

describe('resolveScheme', () => {
  it.each([
    ['system', 'light', 'light'],
    ['system', 'dark', 'dark'],
    ['system', null, 'dark'],
    ['system', 'unspecified', 'dark'],
    ['dark', 'light', 'dark'],
    ['light', 'dark', 'light'],
  ] as const)('preference %s with system %s gives %s', (preference, system, expected) => {
    expect(resolveScheme(preference, system)).toBe(expected);
  });
});

describe('ThemeProvider', () => {
  let theme: Theme | undefined;
  function Probe() {
    theme = useTheme();
    return <Text>{theme.scheme}</Text>;
  }

  it('serves the colours for the chosen scheme and switches when the preference changes', async () => {
    await render(
      <ThemeProvider initialPreference="dark">
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByText('dark')).toBeOnTheScreen();
    expect(theme?.colors).toBe(COLORS.dark);

    await act(() => theme?.setPreference('light'));
    expect(screen.getByText('light')).toBeOnTheScreen();
    expect(theme?.colors).toBe(COLORS.light);
    expect(theme?.preference).toBe('light');
  });

  it('throws a clear error when used outside the provider', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(render(<Probe />)).rejects.toThrow('useTheme must be used inside <ThemeProvider>');
  });
});
