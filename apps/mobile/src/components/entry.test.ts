import { parseMajor } from '@nem/shared';

import { applyAmountKey, formatAmountEntry, sanitizeCode, type KeypadKey } from './entry';

const type = (keys: readonly KeypadKey[], minorDigits = 2, max?: number) =>
  keys.reduce((value, key) => applyAmountKey(value, key, minorDigits, max), '');

describe('applyAmountKey', () => {
  it('builds an amount digit by digit', () => {
    expect(type(['1', '5', '0', '0', '.', '5'])).toBe('1500.5');
  });

  it('drops a leading zero', () => {
    expect(type(['0', '0', '7'])).toBe('7');
  });

  it('starts a bare decimal point with a zero', () => {
    expect(type(['.', '5'])).toBe('0.5');
  });

  it('ignores a second decimal point', () => {
    expect(type(['1', '.', '.', '2'])).toBe('1.2');
  });

  it('ignores digits beyond the currency minor units', () => {
    expect(type(['9', '.', '9', '9', '9'])).toBe('9.99');
  });

  it('ignores the decimal point for currencies without minor units', () => {
    expect(type(['5', '.', '1'], 0)).toBe('51');
  });

  it('caps the whole part', () => {
    expect(type(['1', '2', '3', '4'], 2, 3)).toBe('123');
  });

  it('deletes the last character and clears everything', () => {
    expect(applyAmountKey('12.5', 'backspace', 2)).toBe('12.');
    expect(applyAmountKey('12.5', 'clear', 2)).toBe('');
  });

  it('always produces something parseMajor accepts', () => {
    for (const raw of [type(['.']), type(['4', '.']), type(['4', '.', '0', '5'])]) {
      expect(() => parseMajor(raw, 'NGN')).not.toThrow();
    }
  });
});

describe('formatAmountEntry', () => {
  it('groups thousands and keeps what was typed after the point', () => {
    expect(formatAmountEntry('1234567.5')).toBe('1,234,567.5');
    expect(formatAmountEntry('50.')).toBe('50.');
  });

  it('shows zero when empty', () => {
    expect(formatAmountEntry('')).toBe('0');
  });
});

describe('sanitizeCode', () => {
  it('pulls the digits out of pasted text and caps the length', () => {
    expect(sanitizeCode('Your code is 123 456', 6)).toBe('123456');
    expect(sanitizeCode('1234567', 6)).toBe('123456');
  });
});
