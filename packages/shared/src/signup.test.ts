import {
  ageOn,
  dateOfBirthSchema,
  emailSchema,
  lagosToday,
  normalizeNigerianPhone,
  parseDisplayDate,
  personNameSchema,
  signupRequestSchema,
} from './signup';

describe('normalizeNigerianPhone', () => {
  it.each([
    '08031234567',
    '0803 123 4567',
    '803-123-4567',
    '2348031234567',
    '+2348031234567',
    '+234 0803 123 4567',
    '(0803) 123 4567',
  ])('reads %s as +2348031234567', (input) => {
    expect(normalizeNigerianPhone(input)).toBe('+2348031234567');
  });

  it.each(['', '0803123456', '080312345678', '06031234567', '08231234567', '+447911123456', 'abc'])(
    'rejects %s',
    (input) => {
      expect(normalizeNigerianPhone(input)).toBeNull();
    },
  );
});

describe('dates', () => {
  it('uses the Lagos calendar day, an hour ahead of UTC', () => {
    expect(lagosToday(new Date('2026-10-19T22:59:00Z'))).toBe('2026-10-19');
    expect(lagosToday(new Date('2026-10-19T23:00:00Z'))).toBe('2026-10-20');
  });

  it('counts whole years, turning over on the birthday', () => {
    expect(ageOn('2008-10-20', '2026-10-19')).toBe(17);
    expect(ageOn('2008-10-19', '2026-10-19')).toBe(18);
    expect(ageOn('2008-02-29', '2026-02-28')).toBe(17);
    expect(ageOn('2008-02-29', '2026-03-01')).toBe(18);
  });

  it('parses DD/MM/YYYY and rejects dates that do not exist', () => {
    expect(parseDisplayDate('05/03/1994')).toBe('1994-03-05');
    expect(parseDisplayDate('29/02/2001')).toBeNull();
    expect(parseDisplayDate('31/04/1994')).toBeNull();
    expect(parseDisplayDate('5/3/1994')).toBeNull();
  });
});

describe('field schemas', () => {
  beforeAll(() => jest.useFakeTimers({ now: new Date('2026-10-19T12:00:00Z') }));
  afterAll(() => jest.useRealTimers());

  it('accepts adults up to 120 and nobody under 18', () => {
    expect(dateOfBirthSchema.safeParse('2008-10-19').success).toBe(true);
    const minor = dateOfBirthSchema.safeParse('2008-10-20');
    expect(minor.error?.issues[0]?.message).toBe('You must be 18 or older to open an account');
    expect(dateOfBirthSchema.safeParse('1900-01-01').success).toBe(false);
  });

  it('trims names, keeps accents, hyphens and apostrophes, and rejects digits', () => {
    const name = personNameSchema('first name');
    expect(name.parse('  Adébáyọ̀ ')).toBe('Adébáyọ̀');
    expect(name.safeParse("O'Neil-Okafor").success).toBe(true);
    expect(name.safeParse('T0lu').success).toBe(false);
    expect(name.safeParse('   ').error?.issues[0]?.message).toBe('Enter your first name');
  });

  it('lower-cases email', () => {
    expect(emailSchema.parse(' Tolu@Example.COM ')).toBe('tolu@example.com');
    expect(emailSchema.safeParse('tolu@').success).toBe(false);
  });

  it('checks a whole request the way the server does', () => {
    const request = {
      first_name: 'Ada',
      last_name: 'Obi',
      email: 'ada@example.com',
      phone: '+2348031234567',
      date_of_birth: '1994-03-05',
      consent: {
        terms_version: '2026-10',
        privacy_version: '2026-10',
        accepted_at: '2026-10-19T12:00:00.000Z',
      },
    };
    expect(signupRequestSchema.safeParse(request).success).toBe(true);
    expect(signupRequestSchema.safeParse({ ...request, phone: '08031234567' }).success).toBe(false);
  });
});
