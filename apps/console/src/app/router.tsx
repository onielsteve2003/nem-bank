import type { QueryClient } from '@tanstack/react-query';
import {
  type RouterHistory,
  Outlet,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import { useState } from 'react';

import { RouteError } from '@/components/RouteError';
import { Shell } from '@/components/Shell';
import type { Repositories } from '@/data/repositories';
import { ApprovalPage } from '@/features/approvals/ApprovalPage';
import { ApprovalsPage } from '@/features/approvals/ApprovalsPage';
import type { ApprovalStatus } from '@/features/approvals/useApprovals';
import { AuditLogPage } from '@/features/audit/AuditLogPage';
import { requireAccess, requireSession } from '@/features/auth/guards';
import { LoginPage } from '@/features/auth/LoginPage';
import { isActive, useSession } from '@/features/auth/session';
import { ConfigPage } from '@/features/config/ConfigPage';
import { FeatureFlagsPage } from '@/features/config/FeatureFlagsPage';
import { CustomerPage } from '@/features/customers/CustomerPage';
import { CustomersPage } from '@/features/customers/CustomersPage';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { DisputePage } from '@/features/disputes/DisputePage';
import { DisputeQueuePage } from '@/features/disputes/DisputeQueuePage';
import type { DisputeFilter } from '@/features/disputes/useDisputes';
import { FraudCasePage } from '@/features/fraud/FraudCasePage';
import { FraudQueuePage } from '@/features/fraud/FraudQueuePage';
import type { FraudFilter } from '@/features/fraud/useFraud';
import { KycQueuePage } from '@/features/kyc/KycQueuePage';
import { KycReviewPage } from '@/features/kyc/KycReviewPage';
import type { KycQueueStatus } from '@/features/kyc/useKyc';
import { AccountPage } from '@/features/ledger/AccountPage';
import { AccountsPage } from '@/features/ledger/AccountsPage';
import { EntryPage } from '@/features/ledger/EntryPage';
import { JournalPage } from '@/features/ledger/JournalPage';
import { ENTRY_KINDS } from '@/features/ledger/labels';
import { ReconciliationPage } from '@/features/ledger/ReconciliationPage';
import { TrialBalancePage } from '@/features/ledger/TrialBalancePage';
import type { AccountFilters, EntryFilters, EntryKind } from '@/features/ledger/useLedger';
import { OverviewPage } from '@/features/overview/OverviewPage';
import { SimulatorsPage } from '@/features/simulators/SimulatorsPage';
import { SupportPage } from '@/features/support/SupportPage';
import type { InboxFilter } from '@/features/support/useSupport';
import { lagosDate, shiftDate } from '@/lib/dates';

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

const DISPUTE_FILTERS: readonly DisputeFilter[] = [
  'active',
  'resolved_refunded',
  'resolved_declined',
];

const disputeQueueRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/disputes',
  validateSearch: (search: Record<string, unknown>): { status: DisputeFilter } => ({
    status: DISPUTE_FILTERS.find((f) => f === search.status) ?? 'active',
  }),
  beforeLoad: requireAccess('listAdminDisputes'),
  component: function DisputeQueueRoute() {
    const { status } = disputeQueueRoute.useSearch();
    return <DisputeQueuePage filter={status} />;
  },
});

const disputeRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/disputes/$disputeId',
  beforeLoad: requireAccess('getAdminDispute'),
  component: function DisputeRoute() {
    const { disputeId } = disputeRoute.useParams();
    return <DisputePage disputeId={disputeId} />;
  },
});

const INBOX_FILTERS: readonly InboxFilter[] = ['active', 'open', 'resolved'];

const supportRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/support',
  validateSearch: (
    search: Record<string, unknown>,
  ): { status: InboxFilter; mine: boolean; c?: string } => ({
    status: INBOX_FILTERS.find((f) => f === search.status) ?? 'active',
    mine: search.mine === true || search.mine === 'true',
    ...(typeof search.c === 'string' && { c: search.c.slice(0, 64) }),
  }),
  beforeLoad: requireAccess('listAgentConversations'),
  component: function SupportRoute() {
    const { status, mine, c } = supportRoute.useSearch();
    return <SupportPage filter={status} mine={mine} selected={c} />;
  },
});

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

const journalRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/ledger',
  validateSearch: (search: Record<string, unknown>): EntryFilters => ({
    ...(typeof search.kind === 'string' &&
      search.kind in ENTRY_KINDS && { kind: search.kind as EntryKind }),
    ...(typeof search.reference === 'string' &&
      search.reference.trim() && { reference: search.reference.trim().slice(0, 60) }),
    ...(isDate(search.from) && { from: search.from }),
    ...(isDate(search.to) && { to: search.to }),
  }),
  beforeLoad: requireAccess('listJournalEntries'),
  component: function JournalRoute() {
    return <JournalPage filters={journalRoute.useSearch()} />;
  },
});

const entryRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/ledger/entries/$entryId',
  beforeLoad: requireAccess('getJournalEntry'),
  component: function EntryRoute() {
    const { entryId } = entryRoute.useParams();
    return <EntryPage entryId={entryId} />;
  },
});

const ledgerAccountsRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/ledger/accounts',
  validateSearch: (search: Record<string, unknown>): AccountFilters => ({
    ...((search.owner === 'system' || search.owner === 'customer') && { owner: search.owner }),
    ...((search.currency === 'NGN' || search.currency === 'USD') && {
      currency: search.currency,
    }),
  }),
  beforeLoad: requireAccess('listLedgerAccounts'),
  component: function LedgerAccountsRoute() {
    return <AccountsPage filters={ledgerAccountsRoute.useSearch()} />;
  },
});

const ledgerAccountRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/ledger/accounts/$accountId',
  beforeLoad: requireAccess('listLedgerPostings'),
  component: function LedgerAccountRoute() {
    const { accountId } = ledgerAccountRoute.useParams();
    return <AccountPage accountId={accountId} />;
  },
});

const trialBalanceRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/ledger/trial-balance',
  validateSearch: (search: Record<string, unknown>): { asOf?: string } =>
    isDate(search.asOf) ? { asOf: search.asOf } : {},
  beforeLoad: requireAccess('getTrialBalance'),
  component: function TrialBalanceRoute() {
    const { asOf } = trialBalanceRoute.useSearch();
    return <TrialBalancePage asOf={asOf} />;
  },
});

const reconciliationRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/ledger/reconciliation',
  validateSearch: (search: Record<string, unknown>): { date?: string } =>
    isDate(search.date) ? { date: search.date } : {},
  beforeLoad: requireAccess('getReconciliationReport'),
  component: function ReconciliationRoute() {
    const { date } = reconciliationRoute.useSearch();
    // Yesterday by default: today's partner file arrives tomorrow morning.
    const [yesterday] = useState(() => shiftDate(lagosDate(Date.now()), -1));
    return <ReconciliationPage date={date ?? yesterday} />;
  },
});

const configRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/config',
  beforeLoad: requireAccess('getBankConfig'),
  component: ConfigPage,
});

const featureFlagsRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/feature-flags',
  beforeLoad: requireAccess('listFeatureFlags'),
  component: FeatureFlagsPage,
});

const auditRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/audit',
  beforeLoad: requireAccess('listAuditLog'),
  component: AuditLogPage,
});

const APPROVAL_STATUSES: readonly ApprovalStatus[] = ['pending', 'approved', 'rejected', 'expired'];

const approvalsRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/approvals',
  validateSearch: (search: Record<string, unknown>): { status: ApprovalStatus } => ({
    status: APPROVAL_STATUSES.find((s) => s === search.status) ?? 'pending',
  }),
  beforeLoad: requireAccess('listApprovalRequests'),
  component: function ApprovalsRoute() {
    const { status } = approvalsRoute.useSearch();
    return <ApprovalsPage status={status} />;
  },
});

const approvalRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/approvals/$approvalId',
  beforeLoad: requireAccess('getApprovalRequest'),
  component: function ApprovalRoute() {
    const { approvalId } = approvalRoute.useParams();
    return <ApprovalPage approvalId={approvalId} />;
  },
});

const simulatorsRoute = createRoute({
  getParentRoute: () => staffRoute,
  path: '/simulators',
  beforeLoad: requireAccess('simulateCardCharge'),
  component: SimulatorsPage,
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
    disputeQueueRoute,
    disputeRoute,
    supportRoute,
    journalRoute,
    entryRoute,
    ledgerAccountsRoute,
    ledgerAccountRoute,
    trialBalanceRoute,
    reconciliationRoute,
    configRoute,
    featureFlagsRoute,
    auditRoute,
    approvalsRoute,
    approvalRoute,
    simulatorsRoute,
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
