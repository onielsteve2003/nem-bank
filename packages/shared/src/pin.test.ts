import {
  formatLockoutWait,
  isDateOfBirthPin,
  isWeakPin,
  pinLockoutMinutes,
  pinSchema,
} from './pin';

describe('isWeakPin', () => {
  it.each(['1111', '000000', '1234', '4321', '123456', '987654'])('rejects %s', (pin) => {
    expect(isWeakPin(pin)).toBe(true);
  });

  it.each(['2580', '1357', '9021', '481516'])('accepts %s', (pin) => {
    expect(isWeakPin(pin)).toBe(false);
  });
});

describe('date-of-birth PINs', () => {
  it.each(['1994', '0503', '0305', '0394', '050394', '030594', '940305'])(
    'rejects %s for 1994-03-05',
    (pin) => {
      expect(isDateOfBirthPin(pin, '1994-03-05')).toBe(true);
      expect(isWeakPin(pin, '1994-03-05')).toBe(true);
    },
  );

  it('allows other PINs and ignores the date when it is unknown', () => {
    expect(isWeakPin('2580', '1994-03-05')).toBe(false);
    expect(isWeakPin('0503')).toBe(false);
  });
});

describe('pinSchema', () => {
  it('accepts 4 or 6 digits that are hard to guess', () => {
    expect(pinSchema.safeParse('2580').success).toBe(true);
    expect(pinSchema.safeParse('25801').success).toBe(false);
    expect(pinSchema.safeParse('1234').success).toBe(false);
  });
});

describe('PIN lockout backoff', () => {
  it('quadruples each lockout in a row, up to a day', () => {
    expect([1, 2, 3, 4, 5].map(pinLockoutMinutes)).toEqual([30, 120, 480, 1440, 1440]);
  });

  it('says how long to wait in the largest whole unit, rounding up', () => {
    expect(formatLockoutWait(0.2)).toBe('1 minute');
    expect(formatLockoutWait(29.5)).toBe('30 minutes');
    expect(formatLockoutWait(61)).toBe('2 hours');
    expect(formatLockoutWait(1440)).toBe('1 day');
  });
});
