import { Link } from '@tanstack/react-router';

import { Badge } from '@/components/Badge';
import { ErrorState, Skeleton } from '@/components/PageState';

import { CustomerActions } from './CustomerActions';
import {
  AccountsSection,
  DevicesSection,
  ProfileSection,
  TransactionsSection,
} from './CustomerSections';
import { FLAG_LABELS, STATUS_LABELS, STATUS_TONE } from './labels';
import { NotesSection } from './NotesSection';
import { useCustomer360 } from './useCustomers';

export function CustomerPage({ userId }: { userId: string }) {
  const query = useCustomer360(userId);

  if (query.isPending) {
    return (
      <div className="stack" aria-busy="true" aria-label="Loading customer">
        <Skeleton height={36} width={280} />
        <div className="detail-grid">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="card stack">
              <Skeleton width={140} />
              <Skeleton height={80} />
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const data = query.data;
  const { customer } = data;
  return (
    <>
      <div className="stack tight">
        <Link to="/customers" search={{ q: '' }} className="back-link">
          ← Customers
        </Link>
        <div className="row space-between align-start">
          <div className="stack tight">
            <h1>{customer.name}</h1>
            <p className="row">
              {customer.nemtag && <span className="muted">@{customer.nemtag}</span>}
              <Badge tone={STATUS_TONE[customer.status]}>{STATUS_LABELS[customer.status]}</Badge>
              {data.flags
                .filter((f) => f !== 'frozen')
                .map((f) => (
                  <Badge key={f} tone={FLAG_LABELS[f][1]}>
                    {FLAG_LABELS[f][0]}
                  </Badge>
                ))}
            </p>
          </div>
          <CustomerActions customer={customer} />
        </div>
      </div>
      <div className="detail-grid">
        <ProfileSection data={data} />
        <AccountsSection data={data} />
        <DevicesSection data={data} />
        <NotesSection userId={customer.user_id} notes={data.notes} />
      </div>
      <TransactionsSection data={data} />
    </>
  );
}
