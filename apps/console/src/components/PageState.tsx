import type { ReactNode } from 'react';

import { isApiError } from '@/data/errors';

export function Skeleton({
  height = 16,
  width = '100%',
}: {
  height?: number;
  width?: number | string;
}) {
  return <div className="skeleton" style={{ height, width }} aria-hidden="true" />;
}

type ErrorProps = { error: unknown; onRetry?: () => void; title?: string };

export function ErrorState({ error, onRetry, title = 'Could not load this' }: ErrorProps) {
  const detail = isApiError(error) ? error.message : 'Check your connection and try again.';
  return (
    <div className="card state" role="alert">
      <h2>{title}</h2>
      <p className="muted">{detail}</p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card state">
      <h2>{title}</h2>
      {children && <p className="muted">{children}</p>}
    </div>
  );
}
