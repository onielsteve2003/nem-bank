import { Link, type ErrorComponentProps } from '@tanstack/react-router';

import { ForbiddenError } from '@/features/auth/guards';

import { ErrorState } from './PageState';

export function RouteError({ error, reset }: ErrorComponentProps) {
  if (error instanceof ForbiddenError) {
    return (
      <div className="card state" role="alert">
        <h1>No access</h1>
        <p className="muted">
          Your role can't open this page. Ask an admin if you need it for your work.
        </p>
        <Link to="/" className="btn">
          Back to overview
        </Link>
      </div>
    );
  }
  return <ErrorState error={error} onRetry={reset} title="This page failed to load" />;
}
