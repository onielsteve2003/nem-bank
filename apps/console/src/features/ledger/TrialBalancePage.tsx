import { useNavigate } from '@tanstack/react-router';

import { Badge } from '@/components/Badge';
import { MoneyText } from '@/components/MoneyText';
import { ErrorState, Skeleton } from '@/components/PageState';
import { formatDateTime } from '@/lib/dates';

import { LedgerTabs } from './LedgerTabs';
import { useTrialBalance } from './useLedger';

/** The end of a Lagos calendar day (UTC+1, no daylight saving) as a timestamp. */
const endOfLagosDay = (date: string) => new Date(`${date}T23:59:59.999+01:00`).toISOString();

/** ADM-7: proves every currency's postings sum to zero, now or at the end of any past day. */
export function TrialBalancePage({ asOf }: { asOf: string | undefined }) {
  const navigate = useNavigate();
  const query = useTrialBalance(asOf ? endOfLagosDay(asOf) : undefined);

  return (
    <>
      <div className="stack tight">
        <h1>Ledger</h1>
        <p className="muted">
          Every entry’s postings sum to zero, so the whole ledger must too, in each currency.
        </p>
      </div>
      <LedgerTabs />

      <div className="row filters">
        <label className="field">
          As of the end of
          <input
            type="date"
            className="input"
            value={asOf ?? ''}
            onChange={(e) =>
              void navigate({
                to: '/ledger/trial-balance',
                search: e.target.value ? { asOf: e.target.value } : {},
              })
            }
          />
        </label>
        {asOf && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void navigate({ to: '/ledger/trial-balance', search: {} })}
          >
            Back to now
          </button>
        )}
      </div>

      {query.isPending ? (
        <div className="tile-grid" aria-busy="true" aria-label="Loading trial balance">
          <Skeleton height={180} />
          <Skeleton height={180} />
        </div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <section
            className="card proof"
            role="status"
            data-balanced={query.data.balanced}
            aria-busy={query.isFetching}
          >
            <h2>{query.data.balanced ? 'The ledger balances' : 'The ledger does not balance'}</h2>
            <p className="muted">
              As of {formatDateTime(query.data.as_of)} · worked out from every posting in{' '}
              <span className="num">{query.data.generated_in_ms} ms</span>
            </p>
          </section>
          <div className="tile-grid">
            {query.data.currencies.map((line) => (
              <section
                key={line.currency}
                className="card stack"
                aria-labelledby={`tb-${line.currency}`}
              >
                <div className="row space-between">
                  <h2 id={`tb-${line.currency}`}>{line.currency}</h2>
                  <Badge tone={line.balanced ? 'success' : 'danger'}>
                    {line.balanced ? 'Sums to zero' : 'Out of balance'}
                  </Badge>
                </div>
                <dl className="facts">
                  <dt>Total debits</dt>
                  <dd>
                    <MoneyText value={line.total_debits} />
                  </dd>
                  <dt>Total credits</dt>
                  <dd>
                    <MoneyText value={line.total_credits} />
                  </dd>
                  <dt>Net</dt>
                  <dd className="strong">
                    <MoneyText value={line.net} />
                  </dd>
                  <dt>Accounts</dt>
                  <dd className="num">{line.accounts}</dd>
                </dl>
              </section>
            ))}
          </div>
        </>
      )}
    </>
  );
}
