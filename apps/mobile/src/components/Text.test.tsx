import { COLORS, TYPE_SCALE } from '@nem/shared';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { ThemeProvider } from '@/theme';

import { Text } from './Text';

const renderDark = (ui: React.ReactElement) =>
  render(<ThemeProvider initialPreference="dark">{ui}</ThemeProvider>);

const styleOf = (text: string) => StyleSheet.flatten(screen.getByText(text).props.style);

describe('Text', () => {
  it('renders body text in the theme text colour by default', async () => {
    await renderDark(<Text>Hello</Text>);
    expect(styleOf('Hello')).toMatchObject({
      ...TYPE_SCALE.body,
      color: COLORS.dark.text,
    });
  });

  it('applies the variant and colour tokens', async () => {
    await renderDark(
      <Text variant="caption" color="danger">
        Failed
      </Text>,
    );
    expect(styleOf('Failed')).toMatchObject({ fontSize: 12, color: COLORS.dark.danger });
  });

  it('marks headings as headers for screen readers', async () => {
    await renderDark(<Text variant="h1">Cards</Text>);
    expect(screen.getByRole('header', { name: 'Cards' })).toBeOnTheScreen();
  });

  it('uses tabular numerals for amounts by default and allows opting in elsewhere', async () => {
    await renderDark(
      <>
        <Text variant="amount">₦1,500.00</Text>
        <Text tabular>12:30</Text>
        <Text>plain</Text>
      </>,
    );
    expect(styleOf('₦1,500.00').fontVariant).toEqual(['tabular-nums']);
    expect(styleOf('12:30').fontVariant).toEqual(['tabular-nums']);
    expect(styleOf('plain').fontVariant).toBeUndefined();
  });

  it('scales with dynamic type, capping large sizes lower than body text', async () => {
    await renderDark(
      <>
        <Text variant="amountLarge">₦50,000.00</Text>
        <Text>Body</Text>
      </>,
    );
    expect(screen.getByText('₦50,000.00').props.maxFontSizeMultiplier).toBe(1.4);
    expect(screen.getByText('Body').props.maxFontSizeMultiplier).toBe(2);
  });
});
