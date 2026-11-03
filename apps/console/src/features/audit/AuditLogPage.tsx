import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import { Badge } from '@/components/Badge';
import { EmptyState, ErrorState, Skeleton } from '@/components/PageState';
import { useDemoControls } from '@/data/provider';
import { formatDateTime } from '@/lib/dates';

import { auditKeys, useAuditLog, useVerifyAudit, type AuditFilters } from './useAudit';

/** The action families the log records; each filters by prefix ("customer" → customer.*). */
const ACTION_GROUPS: readonly [value: string, label: string][] = [
  ['staff', 'Sign-ins'],
  ['customer', 'Customers'],
  ['kyc', 'KYC'],
  ['fraud', 'Fraud'],
  ['dispute', 'Disputes'],
  ['support', 'Support'],
  ['config', 'Configuration'],
  ['feature_flag', 'Feature flags'],
  ['approval', 'Approvals'],
  ['simulator', 'Simulators'],
  ['security', 'Customer security'],
];

const short = (hash: string) => `${hash.slice(0, 10)}…`;

function VerifyPanel() {
  const verify = useVerifyAudit();
  const demo = useDemoControls();
  const queryClient = useQueryClient();
  const [tampered, setTampered] = useState<number | null>(null);
  const result = verify.data;

  const tamper = () => {
    if (!demo) return;
    setTampered(demo.tamperAudit());
    verify.reset();
    void queryClient.invalidateQueries({ queryKey: auditKeys.all });
  };

  return (
    <section className="card stack" aria-labelledby="verify-title">
      <div className="row space-between">
        <div className="stack tight">
          <h2 id="verify-title">Hash chain</h2>
          <p className="muted">
            Each entry's SHA-256 hash covers the entry and the hash before it. Changing or deleting
            any entry breaks every hash after it.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => verify.mutate()}
          disabled={verify.isPending}
        >
          {verify.isPending ? 'Verifying…' : 'Verify chain'}
        </button>
      </div>

      {verify.isError && <ErrorState error={verify.error} title="Could not verify" />}
      {result && (
        <div className="proof card stack tight" data-balanced={result.valid} role="status">
          {result.valid ? (
            <>
              <p className="row">
                <Badge tone="success">Chain intact</Badge>
                <span>
                  {result.checked.toLocaleString('en-NG')} entries checked at{' '}
                  {formatDateTime(result.verified_at)}.
                </span>
              </p>
              <p className="muted hint num" title={result.head_hash}>
                Head #{result.head_seq} · {short(result.head_hash)}
              </p>
            </>
          ) : (
            <>
              <p className="row">
                <Badge tone="danger">Chain broken</Badge>
                <span>Entry #{result.first_broken_seq} does not match its hash.</span>
              </p>
              <p className="muted">
                It was changed after it was written. Entries from #{result.first_broken_seq} on
                can't be trusted until it is investigated; the {result.checked} before it are
                intact.
              </p>
            </>
          )}
        </div>
      )}

      {demo && (
        <p className="muted hint row">
          Demo:
          <button type="button" className="btn btn-small" onClick={tamper}>
            Tamper with an entry
          </button>
          {tampered
            ? `Entry #${tampered} was edited without re-hashing. Verify to see the break.`
            : 'edits an entry directly, the way an insider with database access might.'}
        </p>
      )}
    </section>
  );
}

export function AuditLogPage() {
  const [filters, setFilters] = useState<AuditFilters>({});
  const [resource, setResource] = useState('');
  const log = useAuditLog(filters);
  const rows = log.data?.pages.flatMap((p) => p.data) ?? [];
  const filtered = Object.values(filters).some(Boolean);

  const apply = (next: AuditFilters) => setFilters((f) => ({ ...f, ...next }));
  const onSearch = (event: FormEvent) => {
    event.preventDefault();
    apply({ resource_id: resource.trim() || undefined });
  };

  return (
    <>
      <div className="stack tight">
        <h1>Audit log</h1>
        <p className="muted">
          Every staff action and every sensitive customer action, newest first. Entries are never
          edited or deleted.
        </p>
      </div>

      <VerifyPanel />

      <form className="row filters" onSubmit={onSearch} aria-label="Filter the audit log">
        <label className="field">
          Action
          <select
            className="select"
            value={filters.action ?? ''}
            onChange={(e) => apply({ action: e.target.value || undefined })}
          >
            <option value="">All actions</option>
            {ACTION_GROUPS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          From
          <input
            type="date"
            className="input"
            value={filters.from ?? ''}
            onChange={(e) => apply({ from: e.target.value || undefined })}
          />
        </label>
        <label className="field">
          To
          <input
            type="date"
            className="input"
            value={filters.to ?? ''}
            onChange={(e) => apply({ to: e.target.value || undefined })}
          />
        </label>
        <label className="field grow">
          Resource ID
          <input
            className="input"
            value={resource}
            maxLength={64}
            placeholder="A customer, case or approval ID"
            onChange={(e) => setResource(e.target.value)}
          />
        </label>
        <button type="submit" className="btn">
          Search
        </button>
        {filtered && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setResource('');
              setFilters({});
            }}
          >
            Clear
          </button>
        )}
      </form>

      {log.isPending ? (
        <div className="card stack" aria-busy="true" aria-label="Loading the audit log">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={24} />
          ))}
        </div>
      ) : log.isError ? (
        <ErrorState error={log.error} onRetry={() => void log.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState title="No entries match">Try a wider date range or another action.</EmptyState>
      ) : (
        <section className="card stack" aria-label="Audit entries" aria-busy={log.isFetching}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">When</th>
                <th scope="col">Actor</th>
                <th scope="col">Action</th>
                <th scope="col">Resource</th>
                <th scope="col">Hash</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td className="num">{e.seq}</td>
                  <td className="muted">{formatDateTime(e.at)}</td>
                  <td>
                    {e.actor.name ?? (e.actor.type === 'customer' ? 'Customer' : 'Unknown')}
                    {e.actor.type !== 'staff' && (
                      <span className="muted hint"> {e.actor.type}</span>
                    )}
                  </td>
                  <td>
                    <span className="num">{e.action}</span>
                    {Object.keys(e.metadata).length > 0 && (
                      <span className="muted hint num"> {JSON.stringify(e.metadata)}</span>
                    )}
                  </td>
                  <td>
                    <span className="muted hint">{e.resource.type}</span>{' '}
                    <span className="num" title={e.resource.id}>
                      {e.resource.id.length > 14 ? `…${e.resource.id.slice(-8)}` : e.resource.id}
                    </span>
                  </td>
                  <td className="num muted hint" title={`hash ${e.hash}\nprev ${e.prev_hash}`}>
                    {short(e.hash)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {log.hasNextPage && (
            <button
              type="button"
              className="btn"
              onClick={() => void log.fetchNextPage()}
              disabled={log.isFetchingNextPage}
            >
              {log.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </section>
      )}
    </>
  );
}
