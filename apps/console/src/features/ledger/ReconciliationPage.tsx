import { useNavigate } from '@tanstack/react-router';

import { Badge } from '@/components/Badge';
import { MoneyText } from '@/components/MoneyText';
import { ErrorState, Skeleton } from '@/components/PageState';
import { formatDateTime } from '@/lib/dates';

import { RECON_STATUS } from './labels';
import { LedgerTabs } from './LedgerTabs';
import { useReconciliation } from './useLedger';

/** The ledger against the partner's settlement file for one day; only breaks are listed. */
export function ReconciliationPage({ date }: { date: string }) {
  const navigate = useNavigate();
  const report = useReconciliation(date);

  return (
    <>
      <div className="stack tight">
        <h1>Ledger</h1>
        <p className="muted">
          What the ledger says crossed the settlement partner, against the partner’s own file.
        </p>
      </div>
      <LedgerTabs />

      <div className="row filters">
        <label className="field">
          Settlement day
          <input
            type="date"
            className="input"
            value={date}
            required
            onChange={(e) =>
              e.target.value &&
              void navigate({ to: '/ledger/reconciliation', search: { date: e.target.value } })
            }
          />
        </label>
      </div>

      {report.isPending ? (
        <div className="card stack" aria-busy="true" aria-label="Loading report">
          <Skeleton height={48} />
          <Skeleton height={160} />
        </div>
      ) : report.isError ? (
        <ErrorState title="No report for this day" error={report.error} />
      ) : (
        <>
          <div className="tile-grid">
            <div className="card stat-tile">
              <span className="stat-label">Matched</span>
              <span className="stat-value num">{report.data.matched}</span>
            </div>
            <div className="card stat-tile">
              <span className="stat-label">Breaks</span>
              <span className="stat-value num">{report.data.unmatched}</span>
            </div>
            <div className="card stat-tile">
              <span className="stat-label">Partner</span>
              <span>{report.data.partner}</span>
              <span className="stat-hint muted">
                Generated {formatDateTime(report.data.generated_at)}
              </span>
            </div>
          </div>
          {report.data.items.length === 0 ? (
            <section className="card state" role="status">
              <h3>Fully reconciled</h3>
              <p className="muted">Every line in the ledger matches the partner’s file.</p>
            </section>
          ) : (
            <section className="card stack" aria-label="Breaks">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Reference</th>
                    <th scope="col">Break</th>
                    <th scope="col" className="numeric">
                      Ledger
                    </th>
                    <th scope="col" className="numeric">
                      Partner
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.data.items.map((item) => {
                    const [label, tone] = RECON_STATUS[item.status];
                    return (
                      <tr key={item.reference}>
                        <td className="num">{item.reference}</td>
                        <td>
                          <Badge tone={tone}>{label}</Badge>
                        </td>
                        <td className="numeric">
                          {item.ledger_amount ? <MoneyText value={item.ledger_amount} /> : '—'}
                        </td>
                        <td className="numeric">
                          {item.partner_amount ? <MoneyText value={item.partner_amount} /> : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="muted hint">
                Breaks are investigated in suspense; a fix posts as a manual adjustment, which a
                second Finance or Admin member approves.
              </p>
            </section>
          )}
        </>
      )}
    </>
  );
}
