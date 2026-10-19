// Password strength (AUTH-3): zxcvbn-style rules without the 800 KB dictionary.
// Length carries most of the score; known-breached roots, keyboard walks and the
// user's own details are refused outright. The app's meter and the mock bank
// both use this, so what the meter calls acceptable is what the bank accepts.

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordScore = 0 | 1 | 2 | 3 | 4;

export const PASSWORD_SCORE_LABELS = [
  'Very weak',
  'Weak',
  'Fair',
  'Strong',
  'Very strong',
] as const;

/** Lowercased roots that top every breach list, plus the local favourites. */
const BREACHED_ROOTS = [
  'password',
  'passw0rd',
  'qwerty',
  'azerty',
  'asdfgh',
  'zxcvbn',
  'letmein',
  'welcome',
  'iloveyou',
  'admin',
  'monkey',
  'dragon',
  'football',
  'baseball',
  'sunshine',
  'princess',
  'master',
  'shadow',
  'trustno1',
  'abc123',
  'nigeria',
  'naija',
  'lagos',
  'abuja',
  'jesus',
  'blessed',
  'godisgood',
  'nembank',
] as const;

const SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz',
  '01234567890',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
];

export interface PasswordContext {
  /** Names, email and date of birth: anything an attacker who knows the user would try. */
  firstName?: string;
  lastName?: string;
  email?: string;
  /** ISO date, YYYY-MM-DD. */
  dateOfBirth?: string;
}

export interface PasswordCheck {
  score: PasswordScore;
  label: (typeof PASSWORD_SCORE_LABELS)[PasswordScore];
  /** True when the bank will take it: long enough, nothing refused, score 2 or more. */
  acceptable: boolean;
  /** Why it is refused, in the order to fix them. Empty when acceptable. */
  problems: string[];
  /** Optional ways to make it stronger. */
  tips: string[];
}

/** A run of 4+ characters walking up or down the alphabet, digits or a keyboard row. */
function hasSequence(lower: string): boolean {
  for (const row of SEQUENCES) {
    const reversed = [...row].reverse().join('');
    for (let i = 0; i + 4 <= row.length; i++) {
      if (lower.includes(row.slice(i, i + 4)) || lower.includes(reversed.slice(i, i + 4))) {
        return true;
      }
    }
  }
  return false;
}

/** Leetspeak undone, so "P@ssw0rd" is caught as "password". */
function unLeet(lower: string): string {
  return lower
    .replaceAll('@', 'a')
    .replaceAll('4', 'a')
    .replaceAll('3', 'e')
    .replaceAll('1', 'i')
    .replaceAll('!', 'i')
    .replaceAll('0', 'o')
    .replaceAll('$', 's')
    .replaceAll('5', 's')
    .replaceAll('7', 't');
}

function personalParts(context: PasswordContext): string[] {
  const parts = [context.firstName, context.lastName, context.email?.split('@')[0]];
  const [year] = context.dateOfBirth?.split('-') ?? [];
  return [...parts.map((p) => p?.trim().toLowerCase()), year].filter(
    (p): p is string => !!p && p.length >= 3,
  );
}

export function checkPassword(password: string, context: PasswordContext = {}): PasswordCheck {
  const lower = password.toLowerCase();
  const plain = unLeet(lower);
  const problems: string[] = [];
  const tips: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    problems.push(`Use at most ${PASSWORD_MAX_LENGTH} characters`);
  }
  const breached = BREACHED_ROOTS.find((root) => lower.includes(root) || plain.includes(root));
  if (breached) problems.push(`Avoid "${breached}": it is in leaked password lists`);
  if (personalParts(context).some((part) => lower.includes(part) || plain.includes(part))) {
    problems.push('Leave out your name, email and birth year');
  }

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  const repeated = /(.)\1\1/.test(password);
  const sequence = hasSequence(lower);

  let score = password.length >= 16 ? 3 : password.length >= 12 ? 2 : password.length >= 10 ? 1 : 0;
  if (classes >= 3) score += 1;
  if (repeated || sequence) score -= 1;
  if (problems.length > 0) score = Math.min(score, 1);
  const clamped = Math.max(0, Math.min(4, score)) as PasswordScore;

  if (repeated) tips.push('Avoid repeating a character three times');
  if (sequence) tips.push('Avoid runs like "abcd", "1234" or "qwer"');
  if (password.length < 16) tips.push('A longer password, like a short phrase, is stronger');
  if (classes < 3) tips.push('Mix in capitals, numbers or symbols');

  const acceptable = problems.length === 0 && clamped >= 2;
  if (!acceptable && problems.length === 0) problems.push('Make it a little stronger');
  return { score: clamped, label: PASSWORD_SCORE_LABELS[clamped], acceptable, problems, tips };
}
