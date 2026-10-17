// JSON cannot carry bigint. Amounts are tagged as {"$n":"123"} so a round trip is
// exact and nothing is ever parsed through a float.

const TAG = '$n';

export function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? { [TAG]: v.toString() } : v,
  );
}

export function deserialize<T>(text: string): T {
  return JSON.parse(text, (_key, v: unknown) => {
    if (v && typeof v === 'object' && TAG in v && Object.keys(v).length === 1) {
      return BigInt((v as Record<typeof TAG, string>)[TAG]);
    }
    return v;
  }) as T;
}
