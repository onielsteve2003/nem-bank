/** Mulberry32: a tiny seedable PRNG. Deterministic demo data, not cryptography. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const hex = (value: number, width: number) => value.toString(16).padStart(width, '0');

/**
 * UUIDv7 ids (as the API uses): 48-bit millisecond timestamp, version and variant
 * bits, then random bits from `random`. Time-ordered, so sorting by id sorts by time.
 */
export function createIdFactory(now: () => Date, random: () => number = Math.random) {
  const randomBits = (bits: number) => Math.floor(random() * 2 ** bits);
  return (): string => {
    const ms = hex(now().getTime(), 12);
    const versioned = hex(0x7000 | randomBits(12), 4);
    const variant = hex(0x8000 | randomBits(14), 4);
    const tail = hex(randomBits(24), 6) + hex(randomBits(24), 6);
    return `${ms.slice(0, 8)}-${ms.slice(8)}-${versioned}-${variant}-${tail}`;
  };
}
