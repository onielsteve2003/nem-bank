// @nemtag rules (AUTH-10), shared by the chooser screen and the mock bank, and
// matching the contract's Nemtag pattern: a letter, then letters, digits or _.

export const NEMTAG_MIN_LENGTH = 3;
export const NEMTAG_MAX_LENGTH = 20;
export const NEMTAG_PATTERN = /^[a-z][a-z0-9_]{2,19}$/;

/** Handles nobody can own: they would look like the bank talking. */
export const RESERVED_NEMTAGS: readonly string[] = [
  'nem',
  'nembank',
  'admin',
  'support',
  'help',
  'security',
  'official',
  'staff',
];

/** What people type ("@Tolu_A ") → what the bank stores ("tolu_a"). */
export function normalizeNemtag(input: string): string {
  return input.trim().replace(/^@+/, '').toLowerCase();
}

/** Why a (normalised) tag cannot be used, or null if its shape is fine. */
export function nemtagProblem(tag: string): string | null {
  if (tag.length < NEMTAG_MIN_LENGTH) return `Use at least ${NEMTAG_MIN_LENGTH} characters`;
  if (tag.length > NEMTAG_MAX_LENGTH) return `Use at most ${NEMTAG_MAX_LENGTH} characters`;
  if (!/^[a-z]/.test(tag)) return 'Start with a letter';
  if (!NEMTAG_PATTERN.test(tag)) return 'Use only letters, numbers and _';
  if (RESERVED_NEMTAGS.includes(tag)) return 'This one is reserved. Try another.';
  return null;
}

/** Up to `count` well-formed ideas from a name: "tolu", "tolu_a", "tolu_adebayo", … */
export function nemtagIdeas(firstName: string, lastName: string, count = 3): string[] {
  const clean = (name: string) =>
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  const first = clean(firstName);
  const last = clean(lastName);
  const ideas = [
    first,
    last && `${first}_${last[0]}`,
    last && `${first}_${last}`,
    last && `${first}${last}`,
    last && `${last}_${first}`,
  ];
  return [...new Set(ideas.map((tag) => tag.slice(0, NEMTAG_MAX_LENGTH)))]
    .filter((tag) => nemtagProblem(tag) === null)
    .slice(0, count);
}
