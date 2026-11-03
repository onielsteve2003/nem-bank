import { ErrorState, Skeleton } from '@/components/PageState';
import { useStaffMe } from '@/features/auth/useStaffMe';

export function OverviewPage() {
  const me = useStaffMe();

  return (
    <>
      <h1>Overview</h1>
      {me.isPending ? (
        <div className="card stack" aria-busy="true">
          <Skeleton height={24} width={240} />
          <Skeleton width={320} />
        </div>
      ) : me.isError ? (
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
      ) : (
        <div className="card stack">
          <h2>Welcome, {me.data.name}</h2>
          <p className="muted">
            Signed in as {me.data.email} · {me.data.roles.join(', ')}
          </p>
        </div>
      )}
    </>
  );
}
