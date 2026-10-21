import {
  alertTargetProblem,
  alertTitle,
  compareRates,
  nairaRate,
  pointLabel,
  rateChange,
} from '../rates';

it('reads a pair’s rate as naira per unit', () => {
  expect(nairaRate('USD-NGN', '1609.77')).toBe('₦1,609.77');
  expect(alertTitle({ pair: 'GBP-NGN', direction: 'below', target_rate: '1950' })).toBe(
    'GBP/NGN below ₦1,950.00',
  );
});

it('labels chart points by the range: time of day, date, then month', () => {
  // 13:00 UTC is 14:00 in Lagos.
  expect(pointLabel('2026-10-21T13:00:00Z', '1D')).toBe('14:00');
  expect(pointLabel('2026-10-21T13:00:00Z', '1M')).toBe('21 Oct');
  expect(pointLabel('2026-10-21T13:00:00Z', '1Y')).toMatch(/^Oct/);
});

describe('rateChange', () => {
  it('gives the move across the range with its direction', () => {
    expect(rateChange([{ rate: '1600' }, { rate: '1620' }])).toEqual({
      direction: 'up',
      label: '+1.25%',
    });
    expect(rateChange([{ rate: '1600' }, { rate: '1584' }])).toEqual({
      direction: 'down',
      label: '-1.00%',
    });
    expect(rateChange([{ rate: '1600' }, { rate: '1600.01' }])?.direction).toBe('flat');
    expect(rateChange([])).toBeNull();
  });
});

it('compares rates exactly, whatever their decimals', () => {
  expect(compareRates('1650', '1650.00')).toBe(0);
  expect(compareRates('1650.1', '1650.09')).toBe(1);
  expect(compareRates('0.0006', '0.00061')).toBe(-1);
});

describe('alertTargetProblem', () => {
  it('needs a positive naira rate with at most two decimals', () => {
    expect(alertTargetProblem('', 'above', 'USD-NGN', '1600')).toMatch(/Enter a rate/);
    expect(alertTargetProblem('0', 'above', 'USD-NGN', '1600')).toMatch(/Enter a rate/);
    expect(alertTargetProblem('1650.555', 'above', 'USD-NGN', '1600')).toMatch(/Enter a rate/);
    expect(alertTargetProblem('16,500', 'above', 'USD-NGN', '1600')).toMatch(/Enter a rate/);
    expect(alertTargetProblem('1650.5', 'above', 'USD-NGN', '1600')).toBeNull();
  });

  it('refuses an alert that would go off straight away', () => {
    expect(alertTargetProblem('1600', 'above', 'USD-NGN', '1600')).toBe(
      'USD/NGN is already at ₦1,600.00. Pick a higher rate.',
    );
    expect(alertTargetProblem('1650', 'below', 'USD-NGN', '1600')).toMatch(/Pick a lower rate/);
    expect(alertTargetProblem('1550', 'below', 'USD-NGN', '1600')).toBeNull();
  });
});
