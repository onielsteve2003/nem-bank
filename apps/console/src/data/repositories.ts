import type { CallOptions, MethodMap, OperationId, RepoOf } from '@nem/contracts';

// One table per domain: method name → OpenAPI operation ID, the same pattern as the
// mobile app. Method types come from the contract, so the mock and the Phase 2 http
// client can never drift from the API.

export const REPOSITORY_METHODS = {
  auth: {
    login: 'staffLogin',
    verifyTotp: 'staffVerifyTotp',
    logout: 'staffLogout',
    me: 'getStaffMe',
  },
  dashboard: { get: 'getAdminDashboard' },
  customers: {
    search: 'searchCustomers',
    get: 'getCustomer360',
    addNote: 'addCustomerNote',
    freeze: 'freezeCustomer',
    requestUnfreeze: 'requestCustomerUnfreeze',
    requestLimitOverride: 'requestLimitOverride',
  },
  kyc: { list: 'listKycReviews', get: 'getKycReview', decide: 'decideKycReview' },
  fraud: {
    list: 'listFraudCases',
    get: 'getFraudCase',
    assign: 'assignFraudCase',
    decide: 'decideFraudCase',
  },
  disputes: { list: 'listAdminDisputes', get: 'getAdminDispute', decide: 'decideDispute' },
  support: {
    listConversations: 'listAgentConversations',
    listMessages: 'listAgentMessages',
    sendMessage: 'sendAgentMessage',
    resolve: 'resolveConversation',
  },
  ledger: {
    listAccounts: 'listLedgerAccounts',
    listPostings: 'listLedgerPostings',
    listEntries: 'listJournalEntries',
    getEntry: 'getJournalEntry',
    trialBalance: 'getTrialBalance',
    reconciliation: 'getReconciliationReport',
    requestAdjustment: 'requestLedgerAdjustment',
  },
  config: {
    get: 'getBankConfig',
    requestChange: 'requestConfigChange',
    listFlags: 'listFeatureFlags',
    updateFlag: 'updateFeatureFlag',
  },
  audit: { list: 'listAuditLog', verify: 'verifyAuditLog' },
  approvals: {
    list: 'listApprovalRequests',
    get: 'getApprovalRequest',
    approve: 'approveRequest',
    reject: 'rejectRequest',
  },
  simulators: {
    charge: 'simulateCardCharge',
    capture: 'captureSimulatedCharge',
    reverse: 'reverseSimulatedCharge',
    getBankPartner: 'getBankPartnerSimulator',
    setBankPartner: 'setBankPartnerSimulator',
  },
} as const satisfies Readonly<Record<string, MethodMap>>;

type Methods = typeof REPOSITORY_METHODS;
export type Domain = keyof Methods;
export type Repositories = { readonly [D in Domain]: RepoOf<Methods[D]> };

export const DOMAINS = Object.keys(REPOSITORY_METHODS) as Domain[];

/** One call through a repository: which operation, with what input. */
export interface Call {
  operationId: OperationId;
  input: unknown;
  options: CallOptions | undefined;
}

export type Dispatcher = (call: Call) => Promise<unknown>;

/** Builds every repository from one dispatcher (mock now, http in Phase 2). */
export function repositoriesFromDispatcher(dispatch: Dispatcher): Repositories {
  const entries = DOMAINS.map((domain) => {
    const methods = REPOSITORY_METHODS[domain] as Readonly<Record<string, OperationId>>;
    const repo = Object.fromEntries(
      Object.entries(methods).map(([method, operationId]) => [
        method,
        (input?: unknown, options?: CallOptions) => dispatch({ operationId, input, options }),
      ]),
    );
    return [domain, Object.freeze(repo)] as const;
  });
  // The REPOSITORY_METHODS tables and the dispatcher are what make this cast sound.
  return Object.freeze(Object.fromEntries(entries)) as unknown as Repositories;
}
