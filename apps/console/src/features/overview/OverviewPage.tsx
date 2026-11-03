import { ErrorState, Skeleton } from '@/components/PageState';
import { CONSOLE_AREAS, ROLE_LABELS, canCall } from '@/features/auth/access';
import { useStaffMe } from '@/features/auth/useStaffMe';

export function OverviewPage() {
  const me = useStaffMe();

  if (me.isPending) {
    return (
      <div className="card stack" aria-busy="true">
        <Skeleton height={28} width={260} />
        <Skeleton width={320} />
      </div>
    );
  }
  if (me.isError) return <ErrorState error={me.error} onRetry={() => void me.refetch()} />;

  const staff = me.data;
  return (
    <>
      <div className="stack">
        <h1>My access</h1>
        <p className="muted">
          {staff.name} · {staff.email} · {staff.roles.map((r) => ROLE_LABELS[r]).join(', ')}
        </p>
      </div>
      <section className="card stack" aria-labelledby="access-title">
        <h2 id="access-title">What your role can open</h2>
        <p className="muted">
          Access comes from the API contract's role list, the same rules the server enforces.
        </p>
        <ul className="access-list">
          {CONSOLE_AREAS.map((area) => {
            const allowed = canCall(staff.roles, area.operationId);
            return (
              <li key={area.operationId} data-allowed={allowed}>
                <span>
                  <strong>{area.label}</strong>
                  <span className="muted"> · {area.description}</span>
                </span>
                <span className="badge">{allowed ? '✓ Allowed' : '✕ No access'}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
