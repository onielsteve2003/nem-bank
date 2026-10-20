import type { Schema } from '@nem/contracts';
import type { KycTier } from '@nem/shared';

// Everything the mock bank knows besides the ledger. Records are stored in their
// contract shape where that is possible, so reads are a lookup, not a mapping;
// balances are never stored here, they are always read from the ledger.

/** Another Nem customer the demo persona can pay, request from or split with. */
export interface Person {
  userId: string;
  firstName: string;
  lastName: string;
  nemtag: string;
  accountId: string;
  accountNumber: string;
  tier: KycTier;
}

export interface TransferRecord extends Schema<'Transfer'> {
  destination: { kind: 'nem'; accountId: string } | { kind: 'bank'; bankCode: string };
  beneficiaryId: string | null;
  holdId: string | null;
  /** When the sandbox partner answers (external) or the cooling-off delay ends. */
  dueAt: string | null;
  category: Schema<'Category'> | null;
  /** Set when the transfer pays a money request, split share or payment link. */
  paysRequestId: string | null;
  /** Demo Controls "fail next transfer" was armed when this one was sent. */
  willFail: boolean;
}

export interface ScheduledRecord extends Schema<'ScheduledTransfer'> {
  destination: Schema<'TransferDestination'>;
}

export interface CardRecord extends Schema<'Card'> {
  pan: string;
  cvv: string;
}

export interface GoalRecord extends Omit<Schema<'SavingsGoal'>, 'balance' | 'progress_pct'> {
  accountId: string;
}

export interface LockRecord extends Omit<Schema<'LockedSaving'>, 'accrued_interest'> {
  accountId: string;
}

export interface AjoRecord extends Omit<Schema<'AjoGroup'>, 'pot_balance'> {
  escrowAccountId: string;
  sourceAccountId: string;
  inviteCode: string;
  cycles: Schema<'AjoCycle'>[];
}

export interface LoanRecord extends Omit<Schema<'Loan'>, 'outstanding' | 'next_due'> {
  loanAccountId: string;
  repaymentAccountId: string;
}

export interface DependantRecord extends Omit<Schema<'Dependant'>, 'balance'> {
  person: Person;
}

export interface OtpRecord {
  code: string;
  purpose: 'signup' | 'password_reset' | 'step_up';
  destination: string;
  expiresAt: string;
  resendAt: string;
  attempts: number;
  signup?: Schema<'SignupRequest'>;
  verified?: boolean;
}

export interface World {
  /** Demo Controls time travel: days added to the device clock. */
  clockOffsetDays: number;
  failNextTransfer: boolean;
  accountMeta: Record<string, { accountNumber: string; nickname: string | null }>;
  people: Person[];
  auth: {
    password: string;
    pin: string;
    pinFailures: number;
    pinLockedUntil: string | null;
    /** Lockouts in a row, for the escalating backoff; missing in older snapshots. */
    pinLockouts?: number;
    duressPin: string | null;
    securityQuestion: { question: string; answer: string } | null;
    biometricsOn: boolean;
  };
  otps: Record<string, OtpRecord>;
  stepUps: Record<string, { purpose: Schema<'StepUpPurpose'>; expiresAt: string; otpId: string }>;
  stepUpTokens: Record<string, { purpose: Schema<'StepUpPurpose'>; expiresAt: string }>;
  devices: Schema<'Device'>[];
  sessions: Schema<'Session'>[];
  currentDeviceId: string;
  pushTokens: Record<string, string>;
  preferences: Schema<'Preferences'>;
  notificationPreferences: Schema<'NotificationPreferences'>;
  alertPreferences: Schema<'AlertPreferences'>;
  selfLimits: {
    daily: Schema<'Money'> | null;
    single: Schema<'Money'> | null;
    /** A raised limit waits 24 hours unless confirmed with step-up (SEC-3). */
    pending: {
      daily: Schema<'Money'> | null;
      single: Schema<'Money'> | null;
      effectiveAt: string;
    } | null;
  };
  panic: { active: boolean; activatedAt: string | null; frozenCardIds: string[] };
  categoryOverrides: Record<string, Schema<'Category'>>;
  /** Idempotency for operations whose result is a record rather than one ledger entry. */
  idempotency: Record<string, { fingerprint: string; id: string }>;
  statements: Schema<'Statement'>[];
  beneficiaries: Schema<'Beneficiary'>[];
  transfers: TransferRecord[];
  scheduled: ScheduledRecord[];
  moneyRequests: Schema<'MoneyRequest'>[];
  splitBills: Schema<'SplitBill'>[];
  paymentLinks: Schema<'PaymentLink'>[];
  fxQuotes: Record<string, Schema<'FxQuote'>>;
  fxConversions: Schema<'FxConversion'>[];
  fxAlerts: Schema<'FxAlert'>[];
  cards: CardRecord[];
  billPayments: Schema<'BillPayment'>[];
  savedBillers: Schema<'SavedBiller'>[];
  billSchedules: (Schema<'BillSchedule'> & { payment: Schema<'PayBillRequest'> })[];
  goals: GoalRecord[];
  roundUps: Schema<'RoundUpSettings'>;
  locks: LockRecord[];
  ajo: AjoRecord[];
  loanOffers: Record<string, Schema<'LoanOffer'>>;
  loans: LoanRecord[];
  budgets: Omit<Schema<'Budget'>, 'spent' | 'status'>[];
  kyc: {
    status: Schema<'KycStatus'>;
    documents: Schema<'KycDocument'>[];
    submissions: Schema<'KycSubmission'>[];
    verifiedIds: ('bvn' | 'nin')[];
  };
  disputes: Schema<'Dispute'>[];
  attachments: Schema<'Attachment'>[];
  conversations: Schema<'SupportConversation'>[];
  messages: Schema<'SupportMessage'>[];
  notifications: Schema<'Notification'>[];
  dependants: DependantRecord[];
  approvals: Schema<'FamilyApproval'>[];
  assistant: {
    conversations: Schema<'AssistantConversation'>[];
    messages: (Schema<'AssistantMessage'> & { conversationId: string })[];
    actions: Schema<'PreparedAction'>[];
  };
  privacyRequests: Schema<'PrivacyRequest'>[];
  /** Running number for human-readable references (NEM…, case numbers). */
  sequence: number;
}
