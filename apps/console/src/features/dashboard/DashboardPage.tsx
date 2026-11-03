import { useState } from 'react';

import { MoneyText } from '@/components/MoneyText';
import { ErrorState, Skeleton } from '@/components/PageState';

import { formatBps, formatCount } from './format';
import { StatTile } from './StatTile';
import { TransfersByStatus } from './TransfersByStatus';
import { PERIODS, useDashboard, type PeriodDays } from './useDashboard';
import { VolumeByCurrency } from './VolumeByCurrency';

const QUEUE_LABELS = {
  kyc_pending: 'KYC to review',
  fraud_open: 'Fraud cases open',
  disputes_open: 'Disputes open',
  support_open: 'Support chats waiting',
  approvals_pending: 'Approvals pending',
} as const;

export function DashboardPage() {
  const [days, setDays] = useState<PeriodDays>(30);
  const dashboard = useDashboard(days);
  const data = dashboard.data;

  return (
    <>
      <div className="row space-between">
        <div className="stack tight">
          <h1>Dashboard</h1>
          {data && (
            <p className="muted">
              {data.period_from} to {data.period_to} · Africa/Lagos
            </p>
          )}
        </div>
        <label className="row">
          <span className="sr-only">Period</span>
          <select
            className="select"
            value={days}
            onChange={(e) => setDays(Number(e.target.value) as PeriodDays)}
          >
            {PERIODS.map((p) => (
              <option key={p.days} value={p.days}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!data && dashboard.isPending ? (
        <div className="tile-grid" aria-busy="true" aria-label="Loading dashboard">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="card stack">
              <Skeleton width={120} />
              <Skeleton height={32} width={160} />
            </div>
          ))}
        </div>
      ) : !data ? (
        <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />
      ) : (
        <div className="stack loose" aria-busy={dashboard.isFetching}>
          <div className="tile-grid">
            <StatTile
              label="Customers"
              value={formatCount(data.users_total)}
              hint={`+${formatCount(data.users_new)} new in this period`}
            />
            <StatTile
              label="Active in the last 30 days"
              value={formatCount(data.users_active_30d)}
            />
            <StatTile
              label="Fraud hold rate"
              value={formatBps(data.fraud_hold_rate_bps)}
              hint="Transfers held for staff review"
            />
            <StatTile
              label="FX spread income"
              value={data.fx_pnl[0] ? <MoneyText value={data.fx_pnl[0]} trimZeroMinor /> : '—'}
              hint={
                <>
                  {data.fx_pnl.slice(1).map((m, i) => (
                    <span key={m.currency}>
                      {i > 0 && ' · '}
                      <MoneyText value={m} trimZeroMinor />
                    </span>
                  ))}
                </>
              }
            />
          </div>

          <section aria-labelledby="queues-title" className="stack">
            <h2 id="queues-title">Work queues</h2>
            <div className="tile-grid queues">
              {(Object.keys(QUEUE_LABELS) as (keyof typeof QUEUE_LABELS)[]).map((key) => (
                <StatTile
                  key={key}
                  label={QUEUE_LABELS[key]}
                  value={formatCount(data.queues[key])}
                />
              ))}
            </div>
          </section>

          <div className="chart-grid">
            <VolumeByCurrency volume={data.volume} />
            <TransfersByStatus rows={data.transfers_by_status} />
          </div>
        </div>
      )}
    </>
  );
}
