// Split bill shares (TRF-11), in minor units. Shared by the app's preview and
// the bank, so the shares the customer sees are the shares that are requested.

/** The contract's limit on people per split, not counting the creator. */
export const MAX_SPLIT_PARTICIPANTS = 20;

/** How many hours must pass before the same person can be reminded again. */
export const SPLIT_REMIND_HOURS = 24;

/**
 * Equal shares of `total` between `friends` people, plus the creator when
 * `includeSelf`. Kobo that do not divide evenly go to the creator (or, when the
 * creator is not in it, to the first friend), so the shares always add up.
 */
export function equalShares(
  total: bigint,
  friends: number,
  includeSelf: boolean,
): { self: bigint; friends: bigint[] } {
  const heads = BigInt(friends + (includeSelf ? 1 : 0));
  if (friends < 1 || heads === 0n) return { self: includeSelf ? total : 0n, friends: [] };
  const each = total / heads;
  const remainder = total - each * heads;
  return includeSelf
    ? { self: each + remainder, friends: Array.from({ length: friends }, () => each) }
    : {
        self: 0n,
        friends: Array.from({ length: friends }, (_, i) => each + (i === 0 ? remainder : 0n)),
      };
}

/**
 * Why custom shares cannot be requested, or null. With the creator in the
 * split their share is whatever is left, so friends may ask for less than the
 * total; without them, the friends' shares must be exactly the total.
 */
export function customSharesError(
  total: bigint,
  shares: readonly bigint[],
  includeSelf: boolean,
): string | null {
  if (shares.some((s) => s <= 0n)) return 'Give everyone an amount';
  const asked = shares.reduce((a, b) => a + b, 0n);
  if (asked > total) return 'The shares come to more than the total';
  if (!includeSelf && asked !== total) return 'The shares must add up to the total';
  return null;
}
