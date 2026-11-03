import type { ApiMoney } from '@/lib/money';

import { MoneyText } from '@/components/MoneyText';

type Leaf = string | number | boolean | null | ApiMoney;

const isMoney = (v: unknown): v is ApiMoney =>
  typeof v === 'object' && v !== null && 'amount_minor' in v && 'currency' in v;

/** {fees: {emtl: {...money}}} → [["fees › emtl", money]], keeping money whole. */
function flatten(value: unknown, path: string, out: Map<string, Leaf>) {
  if (isMoney(value) || value === null || typeof value !== 'object') {
    out.set(path, (value ?? null) as Leaf);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const label = Array.isArray(value) ? `#${Number(key) + 1}` : key.replaceAll('_', ' ');
    flatten(child, path ? `${path} › ${label}` : label, out);
  }
  return out;
}

function Value({ value }: { value: Leaf | undefined }) {
  if (value === undefined) return <span className="muted">Not set</span>;
  if (value === null) return <span className="muted">None</span>;
  if (isMoney(value)) return <MoneyText value={value} />;
  return <span className="num">{String(value)}</span>;
}

/** The checker's view of a request: every field it touches, before and after. */
export function ChangeDiff({
  before,
  after,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}) {
  const was = flatten(before ?? {}, '', new Map());
  const will = flatten(after ?? {}, '', new Map());
  const fields = [...new Set([...was.keys(), ...will.keys()])];
  const changed = (f: string) => JSON.stringify(was.get(f)) !== JSON.stringify(will.get(f));
  const count = fields.filter(changed).length;

  return (
    <section className="card stack" aria-labelledby="diff-title">
      <div className="stack tight">
        <h2 id="diff-title">What changes</h2>
        <p className="muted">
          {count === 1 ? '1 field changes.' : `${count} fields change.`} Unchanged fields are shown
          for context.
        </p>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f} data-changed={changed(f)}>
              <th scope="row">
                {f}
                {changed(f) && <span className="sr-only"> (changed)</span>}
              </th>
              <td>
                <Value value={was.get(f)} />
              </td>
              <td className={changed(f) ? 'strong' : undefined}>
                <Value value={will.get(f)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
