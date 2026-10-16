/**
 * Up to two initials from a display name, first and last word ("Ada Lovelace" → "AL").
 * Falls back to "?" so an avatar never renders empty.
 */
export function avatarInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (first === undefined) return '?';
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  // Array.from splits by code point, so an emoji or accented letter stays whole.
  const initial = (word: string | undefined) => (word ? (Array.from(word)[0] ?? '') : '');
  return (initial(first) + initial(last)).toUpperCase();
}
