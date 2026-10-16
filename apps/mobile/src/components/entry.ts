// Pure key handling for the custom keypad inputs, kept out of the components so
// the rules are unit-tested on their own.

export const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;
export type Digit = (typeof DIGITS)[number];
export type KeypadKey = Digit | '.' | 'backspace' | 'clear';

/** Caps typed amounts at 12 whole digits (₦999 billion), far beyond any demo limit. */
export const MAX_WHOLE_DIGITS = 12;

export const isDigit = (key: string): key is Digit => (DIGITS as readonly string[]).includes(key);

/**
 * Applies one key to a typed major-unit amount ("1500.5"). Keys that would make
 * it invalid (a second dot, too many decimals, too many digits) are ignored, so
 * the result always parses with `parseMajor` for the same currency.
 */
export function applyAmountKey(
  current: string,
  key: KeypadKey,
  minorDigits: number,
  maxWholeDigits: number = MAX_WHOLE_DIGITS,
): string {
  if (key === 'clear') return '';
  if (key === 'backspace') return current.slice(0, -1);

  const dot = current.indexOf('.');
  if (key === '.') {
    if (minorDigits === 0 || dot !== -1) return current;
    return current === '' ? '0.' : `${current}.`;
  }

  if (dot !== -1) {
    return current.length - dot - 1 >= minorDigits ? current : current + key;
  }
  if (current === '0') return key; // no leading zeros: "0" then "5" is "5"
  if (current.length >= maxWholeDigits) return current;
  return current + key;
}

/** Groups the whole part of a typed amount for display: "1500.5" -> "1,500.5". */
export function formatAmountEntry(raw: string): string {
  if (raw === '') return '0';
  const [whole = '', fraction] = raw.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/**
 * Keeps the first `length` digits of typed or pasted text, so a pasted
 * "Your code is 123 456" fills a 6-digit OTP as "123456".
 */
export function sanitizeCode(text: string, length: number): string {
  return text.replace(/\D/g, '').slice(0, length);
}
