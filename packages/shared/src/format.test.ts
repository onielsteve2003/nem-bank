import { formatMoney, toMajorString } from './format';
import { money } from './money';

describe('formatMoney', () => {
  it.each([
    [money(123_456, 'NGN'), '₦1,234.56'],
    [money(5, 'USD'), '$0.05'],
    [money(-5, 'USD'), '-$0.05'],
    [money(0, 'GBP'), '£0.00'],
    [money('123456789012345678', 'EUR'), '€1,234,567,890,123,456.78'],
  ])('formats %p as %p', (m, expected) => {
    expect(formatMoney(m)).toBe(expected);
  });

  it('supports display options', () => {
    expect(formatMoney(money(500_000, 'NGN'), { trimZeroMinor: true })).toBe('₦5,000');
    expect(formatMoney(money(500_050, 'NGN'), { trimZeroMinor: true })).toBe('₦5,000.50');
    expect(formatMoney(money(100, 'NGN'), { signPositive: true })).toBe('+₦1.00');
    expect(formatMoney(money(100, 'NGN'), { symbol: false })).toBe('1.00');
  });

  it('gives an ungrouped major string for inputs', () => {
    expect(toMajorString(money(150_050, 'NGN'))).toBe('1500.50');
  });
});
