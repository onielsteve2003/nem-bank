import type { Schema } from '@nem/contracts';
import { useState } from 'react';

import { STATUS_LABELS, formatCount } from './format';

type Props = { rows: Schema<'AdminDashboard'>['transfers_by_status'] };

/**
 * One series, so one hue and no legend; bars sorted by size. Completed is ~94% of
 * transfers and would flatten every other bar, so it is stated as a headline and the
 * bars compare the statuses staff act on, on one linear scale.
 */
export function TransfersByStatus({ rows }: Props) {
  const [asTable, setAsTable] = useState(false);
  const sorted = [...rows].sort((a, b) => b.count - a.count);
  const total = rows.reduce((n, r) => n + r.count, 0);
  const completed = rows.find((r) => r.status === 'completed');
  const rest = sorted.filter((r) => r.status !== 'completed');
  const max = Math.max(1, ...rest.map((r) => r.count));
  const share = (n: number) => (total === 0 ? '0%' : `${((n / total) * 100).toFixed(1)}%`);

  return (
    <section className="card stack" aria-labelledby="by-status-title">
      <div className="row space-between">
        <h2 id="by-status-title">Transfers by status</h2>
        <button type="button" className="btn btn-ghost" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {completed && (
        <p className="muted">
          <span className="num strong">{formatCount(completed.count)}</span> completed (
          {share(completed.count)} of {formatCount(total)}). Everything else:
        </p>
      )}
      {asTable ? (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col" className="numeric">
                Transfers
              </th>
              <th scope="col" className="numeric">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.status}>
                <td>{STATUS_LABELS[r.status]}</td>
                <td className="num numeric">{formatCount(r.count)}</td>
                <td className="num numeric">{share(r.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="bars" aria-label="Transfers by status, excluding completed">
          {rest.map((r) => (
            <li
              key={r.status}
              className="bar-row"
              tabIndex={0}
              aria-label={`${STATUS_LABELS[r.status]}: ${formatCount(r.count)} transfers, ${share(r.count)}`}
            >
              <span className="bar-label">{STATUS_LABELS[r.status]}</span>
              <span className="bar-track" aria-hidden="true">
                <span className="bar-fill" style={{ width: `${(r.count / max) * 100}%` }} />
              </span>
              <span className="num bar-value">{formatCount(r.count)}</span>
              <span className="bar-tip" role="presentation">
                {share(r.count)} of all transfers
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
