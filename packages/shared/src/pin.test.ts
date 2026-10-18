import { isWeakPin, pinSchema } from './pin';

describe('isWeakPin', () => {
  it.each(['1111', '000000', '1234', '4321', '123456', '987654'])('rejects %s', (pin) => {
    expect(isWeakPin(pin)).toBe(true);
  });

  it.each(['2580', '1357', '9021', '481516'])('accepts %s', (pin) => {
    expect(isWeakPin(pin)).toBe(false);
  });
});

describe('pinSchema', () => {
  it('accepts 4 or 6 digits that are hard to guess', () => {
    expect(pinSchema.safeParse('2580').success).toBe(true);
    expect(pinSchema.safeParse('25801').success).toBe(false);
    expect(pinSchema.safeParse('1234').success).toBe(false);
  });
});
