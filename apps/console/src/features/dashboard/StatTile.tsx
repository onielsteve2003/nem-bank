import type { ReactNode } from 'react';

type Props = { label: string; value: ReactNode; hint?: ReactNode };

export function StatTile({ label, value, hint }: Props) {
  return (
    <div className="card stat-tile">
      <span className="stat-label">{label}</span>
      <span className="num stat-value">{value}</span>
      {hint && <span className="muted stat-hint">{hint}</span>}
    </div>
  );
}
