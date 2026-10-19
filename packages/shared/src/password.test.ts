import { checkPassword } from './password';

const ADA = {
  firstName: 'Ada',
  lastName: 'Obiora',
  email: 'ada.obi@example.com',
  dateOfBirth: '1994-03-05',
};

describe('checkPassword', () => {
  it('refuses short passwords', () => {
    const check = checkPassword('Xk7!pq');
    expect(check.acceptable).toBe(false);
    expect(check.problems[0]).toBe('Use at least 10 characters');
    expect(check.score).toBeLessThanOrEqual(1);
  });

  it.each(['Password2026!', 'P@ssw0rd-Lagos', 'MyQwerty#Key', 'Naija4life!!x'])(
    'refuses %s for a breached root, even in leetspeak',
    (password) => {
      const check = checkPassword(password);
      expect(check.acceptable).toBe(false);
      expect(check.problems.join(' ')).toMatch(/leaked password lists/);
      expect(check.score).toBeLessThanOrEqual(1);
    },
  );

  it('refuses the user’s own name, email and birth year', () => {
    for (const password of ['Obiora#Vault88', 'ada.obi-secret!', 'Tuber7#1994zz']) {
      const check = checkPassword(password, ADA);
      expect(check.problems).toContain('Leave out your name, email and birth year');
    }
  });

  it('scores length and variety, and marks runs and repeats down', () => {
    expect(checkPassword('kitchen-mango-river').score).toBe(3);
    expect(checkPassword('Kitchen-Mango-River-7').score).toBe(4);
    expect(checkPassword('Tmb9#vrwkq').score).toBe(2);
    expect(checkPassword('Tmb9#vrwkqaaa').tips).toContain(
      'Avoid repeating a character three times',
    );
    expect(checkPassword('Tmb9#abcdzq').score).toBe(1);
  });

  it('accepts a strong passphrase with nothing to fix', () => {
    const check = checkPassword('Kitchen-Mango-River-7', ADA);
    expect(check).toMatchObject({ acceptable: true, problems: [], label: 'Very strong' });
  });

  it('asks for a little more when nothing is wrong but the score is too low', () => {
    const check = checkPassword('tmbvrwkqzl');
    expect(check.acceptable).toBe(false);
    expect(check.problems).toEqual(['Make it a little stronger']);
  });
});
