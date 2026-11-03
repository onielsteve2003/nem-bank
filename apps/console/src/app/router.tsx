import type { QueryClient } from '@tanstack/react-query';
import {
  type RouterHistory,
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';

import { RouteError } from '@/components/RouteError';
import { Shell } from '@/components/Shell';
import type { Repositories } from '@/data/repositories';
import { requireAccess, requireSession } from '@/features/auth/guards';
import { LoginPage } from '@/features/auth/LoginPage';
import { isActive, useSession } from '@/features/auth/session';
import { CustomerPage } from '@/features/customers/CustomerPage';
import { CustomersPage } from '@/features/customers/CustomersPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { FraudCasePage } from '@/features/fraud/FraudCasePage';
import { FraudQueuePage } from '@/features/fraud/FraudQueuePage';
import type { FraudFilter } from '@/features/fraud/useFraud';
import { KycQueuePage } from '@/features/kyc/KycQueuePage';
import { KycReviewPage } from '@/features/kyc/KycReviewPage';
import type { KycQueueStatus } from '@/features/kyc/useKyc';
import { OverviewPage } from '@/features/overview/OverviewPage';

export interface RouterContext {
  queryClient: QueryClient;
  repositories: Repositories;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  beforeLoad: () => {
    if (isActive(useSession.getState().session)) throw redirect({ to: '/' });
  },
  component: LoginPage,
});

/** Every back-office page sits under this layout: signed in, inside the shell. */
const staffRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'staff',
  beforeLoad: requireSession,
  component: Shell,
  errorComponent: RouteError,
});

const dashboardRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/',
  beforeLoad: requireAccess('getAdminDashboard'),
  component: DashboardPage,
});

const customersRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/customers',
  validateSearch: (search: Record<string, unknown>): { q: string } => ({
    q: typeof search.q === 'string' ? search.q.slice(0, 100) : '',
  }),
  beforeLoad: requireAccess('searchCustomers'),
  component: function CustomersRoute() {
    const { q } = customersRoute.useSearch();
    // Keyed so the search box resets when the URL's query changes (back/forward).
    return <CustomersPage key={q} q={q} />;
  },
});

const customerRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/customers/$userId',
  beforeLoad: requireAccess('getCustomer360'),
  component: function CustomerRoute() {
    const { userId } = customerRoute.useParams();
    return <CustomerPage userId={userId} />;
  },
});

const KYC_STATUSES: readonly KycQueueStatus[] = [
  'pending_review',
  'approved',
  'rejected',
  'resubmit',
];

const kycQueueRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/kyc',
  validateSearch: (search: Record<string, unknown>): { status: KycQueueStatus } => ({
    status: KYC_STATUSES.find((s) => s === search.status) ?? 'pending_review',
  }),
  beforeLoad: requireAccess('listKycReviews'),
  component: function KycQueueRoute() {
    const { status } = kycQueueRoute.useSearch();
    return <KycQueuePage status={status} />;
  },
});

const kycReviewRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/kyc/$submissionId',
  beforeLoad: requireAccess('getKycReview'),
  component: function KycReviewRoute() {
    const { submissionId } = kycReviewRoute.useParams();
    return <KycReviewPage submissionId={submissionId} />;
  },
});

const FRAUD_FILTERS: readonly FraudFilter[] = ['active', 'released', 'rejected'];

const fraudQueueRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/fraud',
  validateSearch: (search: Record<string, unknown>): { status: FraudFilter; mine: boolean } => ({
    status: FRAUD_FILTERS.find((f) => f === search.status) ?? 'active',
    mine: search.mine === true || search.mine === 'true',
  }),
  beforeLoad: requireAccess('listFraudCases'),
  component: function FraudQueueRoute() {
    const { status, mine } = fraudQueueRoute.useSearch();
    return <FraudQueuePage filter={status} mine={mine} />;
  },
});

const fraudCaseRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/fraud/$caseId',
  beforeLoad: requireAccess('getFraudCase'),
  component: function FraudCaseRoute() {
    const { caseId } = fraudCaseRoute.useParams();
    return <FraudCasePage caseId={caseId} />;
  },
});

const myAccessRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/me',
  component: OverviewPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  staffRoute.addChildren([
    dashboardRoute,
    customersRoute,
    customerRoute,
    kycQueueRoute,
    kycReviewRoute,
    fraudQueueRoute,
    fraudCaseRoute,
    myAccessRoute,
  ]),
]);

export function createAppRouter(context: RouterContext, history?: RouterHistory) {
  return createRouter({ routeTree, context, history, defaultPreload: 'intent' });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
