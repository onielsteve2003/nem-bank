// UUIDv7 (time-ordered) for idempotency keys and request IDs, as the API uses.
// Random bits come from crypto.getRandomValues where the runtime has it (web,
// Hermes with a polyfill); otherwise Math.random, which is enough for uniqueness
// keys but never used for secrets.

function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  const crypto = globalThis.crypto as Crypto | undefined;
  if (crypto?.getRandomValues) return crypto.getRandomValues(bytes);
  for (let i = 0; i < count; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
