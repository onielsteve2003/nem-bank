import { addDaysIso, addMonthsIso, statementRangeError } from './statement';

it('moves by whole months and clamps the 31st to the month end', () => {
  expect(addMonthsIso('2026-03-31', -1)).toBe('2026-02-28');
  expect(addMonthsIso('2024-03-31', -1)).toBe('2024-02-29');
  expect(addMonthsIso('2026-01-15', -12)).toBe('2025-01-15');
  expect(addMonthsIso('2026-11-30', 2)).toBe('2027-01-30');
});

it('moves by days across a year end', () => {
  expect(addDaysIso('2025-12-31', 1)).toBe('2026-01-01');
});

it('accepts up to twelve months ending today', () => {
  expect(statementRangeError('2025-10-21', '2026-10-20', '2026-10-20')).toBeNull();
  expect(statementRangeError('2026-10-20', '2026-10-20', '2026-10-20')).toBeNull();
});

it('refuses reversed, future and over-long periods', () => {
  expect(statementRangeError('2026-10-02', '2026-10-01', '2026-10-20')).toMatch(/after/);
  expect(statementRangeError('2026-10-01', '2026-10-21', '2026-10-20')).toMatch(/future/);
  expect(statementRangeError('2025-10-20', '2026-10-20', '2026-10-20')).toMatch(/12 months/);
});
