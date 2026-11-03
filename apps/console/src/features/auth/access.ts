import { OPERATIONS, type RouteOperationId, type StaffRole } from '@nem/contracts';

// Who may open what comes from the contract's `x-roles`, the same list the API
// enforces, so the console never shows a page whose data call would be refused.

export function rolesFor(operationId: RouteOperationId): readonly StaffRole[] {
  const meta = OPERATIONS[operationId] as { roles?: readonly StaffRole[] };
  return meta.roles ?? [];
}

export function canCall(roles: readonly StaffRole[], operationId: RouteOperationId): boolean {
  const allowed = rolesFor(operationId);
  return roles.some((role) => allowed.includes(role));
}

export const ROLE_LABELS: Readonly<Record<StaffRole, string>> = {
  support: 'Support',
  compliance: 'Compliance',
  finance: 'Finance',
  admin: 'Admin',
};

export interface ConsoleArea {
  label: string;
  description: string;
  /** The call the area's page makes first; its roles gate the page. */
  operationId: RouteOperationId;
}

/** Every back-office area (ADM-2 to ADM-11). Pages are added as each one is built. */
export const CONSOLE_AREAS: readonly ConsoleArea[] = [
  { label: 'Dashboard', description: 'KPIs and charts', operationId: 'getAdminDashboard' },
  { label: 'Customers', description: 'Search, 360 view, freeze', operationId: 'searchCustomers' },
  {
    label: 'KYC reviews',
    description: 'Approve or reject documents',
    operationId: 'listKycReviews',
  },
  { label: 'Fraud cases', description: 'Held transfers', operationId: 'listFraudCases' },
  { label: 'Disputes', description: 'Customer disputes', operationId: 'listAdminDisputes' },
  { label: 'Support chat', description: 'Agent inbox', operationId: 'listAgentConversations' },
  { label: 'Ledger', description: 'Entries, trial balance', operationId: 'listJournalEntries' },
  { label: 'Configuration', description: 'Spreads, fees, limits', operationId: 'getBankConfig' },
  { label: 'Feature flags', description: 'Incl. paid features', operationId: 'listFeatureFlags' },
  { label: 'Audit log', description: 'Hash-chained trail', operationId: 'listAuditLog' },
  { label: 'Approvals', description: 'Maker-checker inbox', operationId: 'listApprovalRequests' },
  {
    label: 'Simulators',
    description: 'Merchant and bank partner',
    operationId: 'getBankPartnerSimulator',
  },
];
