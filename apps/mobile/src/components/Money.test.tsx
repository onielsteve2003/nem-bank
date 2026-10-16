import { money } from '@nem/shared';
import { act, render, screen } from '@testing-library/react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { ThemeProvider } from '@/theme';

import { COUNT_UP_MS, MASK, MoneyText, spokenMoney } from './MoneyText';
import { easeOutCubic, interpolateMoney } from './moneyTween';
import { STATUS_META, StatusPill, type TransactionStatus } from './StatusPill';

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  ...jest.requireActual('react-native-reanimated'),
  useReducedMotion: jest.fn(() => false),
}));

const renderThemed = (ui: React.ReactElement) =>
  render(<ThemeProvider initialPreference="dark">{ui}</ThemeProvider>);

const ngn = (kobo: bigint) => money(kobo, 'NGN');

describe('interpolateMoney', () => {
  it('returns the ends exactly', () => {
    expect(interpolateMoney(ngn(0n), ngn(150_000n), 0)).toEqual(ngn(0n));
    expect(interpolateMoney(ngn(0n), ngn(150_000n), 1)).toEqual(ngn(150_000n));
  });

  it('stays exact for amounts beyond float precision', () => {
    const big = ngn(9_007_199_254_740_993_000n);
    expect(interpolateMoney(ngn(0n), big, 0.5).amount).toBe(4_503_599_627_370_496_500n);
  });

  it('rounds each frame to a whole minor unit and counts down too', () => {
    expect(interpolateMoney(ngn(0n), ngn(3n), 0.5)).toEqual(ngn(2n));
    expect(interpolateMoney(ngn(1_000n), ngn(0n), 0.25)).toEqual(ngn(750n));
  });

  it('jumps straight to a new currency', () => {
    expect(interpolateMoney(ngn(100n), money(5n, 'USD'), 0.5)).toEqual(money(5n, 'USD'));
  });

  it('eases out and clamps', () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
    expect(easeOutCubic(2)).toBe(1);
  });
});

describe('MoneyText', () => {
  beforeEach(() => jest.mocked(useReducedMotion).mockReturnValue(false));
  afterEach(() => jest.useRealTimers());

  it('formats and labels the amount', async () => {
    await renderThemed(<MoneyText value={ngn(-50_000n)} label="Fee" />);
    expect(screen.getByText('-₦500.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('Fee, minus ₦500.00')).toBeOnTheScreen();
  });

  it('masks the amount and says it is hidden', async () => {
    await renderThemed(<MoneyText value={ngn(24_850_000n)} label="Balance" masked animate />);
    expect(screen.getByText(`₦${MASK}`)).toBeOnTheScreen();
    expect(screen.getByLabelText('Balance, hidden')).toBeOnTheScreen();
    expect(screen.queryByText(/248/)).toBeNull();
  });

  it('counts up from zero but always announces the final amount', async () => {
    jest.useFakeTimers();
    await renderThemed(<MoneyText value={ngn(100_000n)} animate />);
    expect(screen.getByText('₦0.00')).toBeOnTheScreen();
    expect(screen.getByLabelText('₦1,000.00')).toBeOnTheScreen();
    await act(() => jest.advanceTimersByTime(COUNT_UP_MS + 100));
    expect(screen.getByText('₦1,000.00')).toBeOnTheScreen();
  });

  it('shows the amount at once with reduce motion on', async () => {
    jest.mocked(useReducedMotion).mockReturnValue(true);
    await renderThemed(<MoneyText value={ngn(100_000n)} animate />);
    expect(screen.getByText('₦1,000.00')).toBeOnTheScreen();
  });

  it('spells out minus', () => {
    expect(spokenMoney('-$5.00')).toBe('minus $5.00');
    expect(spokenMoney('+$5.00')).toBe('+$5.00');
  });
});

describe('StatusPill', () => {
  it.each(Object.keys(STATUS_META) as TransactionStatus[])(
    'announces %s with its word',
    async (s) => {
      await renderThemed(<StatusPill status={s} />);
      expect(screen.getByLabelText(`Status: ${STATUS_META[s].label}`)).toBeOnTheScreen();
    },
  );

  it('accepts a custom word', async () => {
    await renderThemed(<StatusPill status="reversed" label="Refunded" />);
    expect(screen.getByText('Refunded')).toBeOnTheScreen();
  });
});
