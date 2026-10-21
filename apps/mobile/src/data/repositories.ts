import type { MethodMap, RepoOf } from './contract';

// One table per domain: method name → OpenAPI operation ID. Screens reach these
// through feature hooks and TanStack Query, never directly (architecture §3).

export const REPOSITORY_METHODS = {
  auth: {
    startSignup: 'startSignup',
    completeSignup: 'completeSignup',
    verifyOtp: 'verifyOtp',
    resendOtp: 'resendOtp',
    login: 'login',
    createDeviceChallenge: 'createDeviceChallenge',
    loginWithDevice: 'loginWithDevice',
    startDemoSession: 'startDemoSession',
    refresh: 'refreshSession',
    logout: 'logout',
    forgotPassword: 'forgotPassword',
    resetPassword: 'resetPassword',
    startStepUp: 'startStepUp',
    verifyStepUp: 'verifyStepUp',
  },
  users: {
    getMe: 'getMe',
    updateMe: 'updateMe',
    checkNemtag: 'checkNemtag',
    setNemtag: 'setNemtag',
    setPin: 'setPin',
    verifyPin: 'verifyPin',
    resetPin: 'resetPin',
    getPreferences: 'getPreferences',
    setPreferences: 'setPreferences',
  },
  devices: { list: 'listDevices', bind: 'bindDevice', revoke: 'revokeDevice' },
  accounts: {
    list: 'listAccounts',
    open: 'openAccount',
    get: 'getAccount',
    listHolds: 'listAccountHolds',
  },
  transactions: {
    list: 'listTransactions',
    get: 'getTransaction',
    update: 'updateTransaction',
    getReceipt: 'getReceipt',
  },
  statements: {
    list: 'listStatements',
    request: 'requestStatement',
    get: 'getStatement',
    download: 'downloadStatement',
  },
  payees: { listBanks: 'listBanks', resolve: 'resolvePayee' },
  transfers: {
    quote: 'quoteTransfer',
    list: 'listTransfers',
    create: 'createTransfer',
    get: 'getTransfer',
    stepUp: 'stepUpTransfer',
    cancel: 'cancelTransfer',
    createInternational: 'createInternationalTransfer',
    listScheduled: 'listScheduledTransfers',
    createScheduled: 'createScheduledTransfer',
    getScheduled: 'getScheduledTransfer',
    updateScheduled: 'updateScheduledTransfer',
    cancelScheduled: 'cancelScheduledTransfer',
  },
  beneficiaries: {
    list: 'listBeneficiaries',
    create: 'createBeneficiary',
    update: 'updateBeneficiary',
    remove: 'deleteBeneficiary',
  },
  moneyRequests: {
    list: 'listMoneyRequests',
    create: 'createMoneyRequest',
    get: 'getMoneyRequest',
    pay: 'payMoneyRequest',
    decline: 'declineMoneyRequest',
    cancel: 'cancelMoneyRequest',
    listSplitBills: 'listSplitBills',
    createSplitBill: 'createSplitBill',
    getSplitBill: 'getSplitBill',
    remindSplitBill: 'remindSplitBill',
  },
  paymentLinks: {
    list: 'listPaymentLinks',
    create: 'createPaymentLink',
    get: 'getPaymentLink',
    update: 'updatePaymentLink',
    getPublic: 'getPublicPaymentLink',
    pay: 'payPaymentLink',
    getMyQr: 'getMyQr',
    decodeQr: 'decodeQr',
  },
  fx: {
    listRates: 'listFxRates',
    getRateHistory: 'getFxRateHistory',
    createQuote: 'createFxQuote',
    listConversions: 'listFxConversions',
    convert: 'convertCurrency',
    listAlerts: 'listFxAlerts',
    createAlert: 'createFxAlert',
    deleteAlert: 'deleteFxAlert',
  },
  cards: {
    list: 'listCards',
    create: 'createCard',
    requestPhysical: 'requestPhysicalCard',
    get: 'getCard',
    updateControls: 'updateCardControls',
    freeze: 'freezeCard',
    unfreeze: 'unfreezeCard',
    reveal: 'revealCard',
    terminate: 'terminateCard',
    replace: 'replaceCard',
    listTransactions: 'listCardTransactions',
  },
  bills: {
    listBillers: 'listBillers',
    listProducts: 'listBillerProducts',
    detectNetwork: 'detectNetwork',
    validateCustomer: 'validateBillCustomer',
    listPayments: 'listBillPayments',
    pay: 'payBill',
    getPayment: 'getBillPayment',
    listSaved: 'listSavedBillers',
    save: 'saveBiller',
    removeSaved: 'deleteSavedBiller',
    listSchedules: 'listBillSchedules',
    createSchedule: 'createBillSchedule',
    cancelSchedule: 'cancelBillSchedule',
  },
  savings: {
    getSummary: 'getSavingsSummary',
    listGoals: 'listSavingsGoals',
    createGoal: 'createSavingsGoal',
    getGoal: 'getSavingsGoal',
    updateGoal: 'updateSavingsGoal',
    closeGoal: 'closeSavingsGoal',
    deposit: 'depositToGoal',
    withdraw: 'withdrawFromGoal',
    getRoundUps: 'getRoundUps',
    setRoundUps: 'setRoundUps',
    quoteLock: 'quoteLockedSaving',
    listLocks: 'listLockedSavings',
    createLock: 'createLockedSaving',
    getLock: 'getLockedSaving',
    breakLock: 'breakLockedSaving',
  },
  ajo: {
    listGroups: 'listAjoGroups',
    createGroup: 'createAjoGroup',
    getGroup: 'getAjoGroup',
    invite: 'inviteToAjoGroup',
    getInvite: 'getAjoInvite',
    acceptInvite: 'acceptAjoInvite',
    start: 'startAjoGroup',
    leave: 'leaveAjoGroup',
    listCycles: 'listAjoCycles',
  },
  credit: {
    getEligibility: 'getCreditEligibility',
    createOffer: 'createLoanOffer',
    listLoans: 'listLoans',
    acceptOffer: 'acceptLoanOffer',
    getLoan: 'getLoan',
    updateLoan: 'updateLoan',
    repay: 'repayLoan',
  },
  insights: {
    getSpending: 'getSpending',
    listBudgets: 'listBudgets',
    createBudget: 'createBudget',
    updateBudget: 'updateBudget',
    deleteBudget: 'deleteBudget',
    getForecast: 'getCashFlowForecast',
    listSubscriptions: 'listDetectedSubscriptions',
    getMoneyStory: 'getMoneyStory',
  },
  security: {
    getCheckup: 'getSecurityCheckup',
    listSessions: 'listSessions',
    revokeSession: 'revokeSession',
    getLimits: 'getSelfLimits',
    setLimits: 'setSelfLimits',
    getPanic: 'getPanicState',
    activatePanic: 'activatePanic',
    releasePanic: 'releasePanic',
    setDuressPin: 'setDuressPin',
    removeDuressPin: 'removeDuressPin',
    setSecurityQuestion: 'setSecurityQuestion',
    checkScam: 'checkScam',
    getAlerts: 'getAlertPreferences',
    setAlerts: 'setAlertPreferences',
  },
  kyc: {
    getOverview: 'getKycOverview',
    verifyIdentity: 'verifyIdentityNumber',
    uploadDocument: 'uploadKycDocument',
    prefill: 'prefillFromId',
    submit: 'submitKyc',
    getSubmission: 'getKycSubmission',
  },
  disputes: {
    list: 'listDisputes',
    create: 'createDispute',
    get: 'getDispute',
    addEvidence: 'addDisputeEvidence',
    withdraw: 'withdrawDispute',
  },
  support: {
    listConversations: 'listSupportConversations',
    startConversation: 'startSupportConversation',
    getConversation: 'getSupportConversation',
    listMessages: 'listSupportMessages',
    sendMessage: 'sendSupportMessage',
    uploadAttachment: 'uploadSupportAttachment',
    searchArticles: 'searchHelpArticles',
    getArticle: 'getHelpArticle',
  },
  notifications: {
    list: 'listNotifications',
    markRead: 'markNotificationsRead',
    getPreferences: 'getNotificationPreferences',
    setPreferences: 'setNotificationPreferences',
    registerPushToken: 'registerPushToken',
    unregisterPushToken: 'unregisterPushToken',
  },
  family: {
    listDependants: 'listDependants',
    createDependant: 'createDependant',
    getDependant: 'getDependant',
    updateControls: 'updateDependantControls',
    setAllowance: 'setAllowance',
    stopAllowance: 'stopAllowance',
    listActivity: 'listDependantActivity',
    listApprovals: 'listFamilyApprovals',
    approve: 'approveFamilyTransfer',
    decline: 'declineFamilyTransfer',
  },
  assistant: {
    startConversation: 'startAssistantConversation',
    listMessages: 'listAssistantMessages',
    sendMessage: 'sendAssistantMessage',
    confirmAction: 'confirmAssistantAction',
    discardAction: 'discardAssistantAction',
  },
  privacy: { requestExport: 'requestDataExport', requestDeletion: 'requestAccountDeletion' },
  realtime: { createTicket: 'createRealtimeTicket' },
  demo: {
    fundWallet: 'demoFundWallet',
    inboundTransfer: 'demoInboundTransfer',
    failNextTransfer: 'demoFailNextTransfer',
    timeTravel: 'demoTimeTravel',
    reset: 'demoReset',
  },
} as const satisfies Readonly<Record<string, MethodMap>>;

type Methods = typeof REPOSITORY_METHODS;

export type Domain = keyof Methods;

export const DOMAINS = Object.keys(REPOSITORY_METHODS) as Domain[];

export type AuthRepo = RepoOf<Methods['auth']>;
export type UsersRepo = RepoOf<Methods['users']>;
export type DevicesRepo = RepoOf<Methods['devices']>;
export type AccountsRepo = RepoOf<Methods['accounts']>;
export type TransactionsRepo = RepoOf<Methods['transactions']>;
export type StatementsRepo = RepoOf<Methods['statements']>;
export type PayeesRepo = RepoOf<Methods['payees']>;
export type TransfersRepo = RepoOf<Methods['transfers']>;
export type BeneficiariesRepo = RepoOf<Methods['beneficiaries']>;
export type MoneyRequestsRepo = RepoOf<Methods['moneyRequests']>;
export type PaymentLinksRepo = RepoOf<Methods['paymentLinks']>;
export type FxRepo = RepoOf<Methods['fx']>;
export type CardsRepo = RepoOf<Methods['cards']>;
export type BillsRepo = RepoOf<Methods['bills']>;
export type SavingsRepo = RepoOf<Methods['savings']>;
export type AjoRepo = RepoOf<Methods['ajo']>;
export type CreditRepo = RepoOf<Methods['credit']>;
export type InsightsRepo = RepoOf<Methods['insights']>;
export type SecurityRepo = RepoOf<Methods['security']>;
export type KycRepo = RepoOf<Methods['kyc']>;
export type DisputesRepo = RepoOf<Methods['disputes']>;
export type SupportRepo = RepoOf<Methods['support']>;
export type NotificationsRepo = RepoOf<Methods['notifications']>;
export type FamilyRepo = RepoOf<Methods['family']>;
export type AssistantRepo = RepoOf<Methods['assistant']>;
export type PrivacyRepo = RepoOf<Methods['privacy']>;
export type RealtimeRepo = RepoOf<Methods['realtime']>;
export type DemoRepo = RepoOf<Methods['demo']>;

/** Every repository the app uses, keyed by domain. */
export type Repositories = { readonly [D in Domain]: RepoOf<Methods[D]> };
