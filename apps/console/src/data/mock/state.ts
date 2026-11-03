import type { Schema, Staff } from '@nem/contracts';

import type { AuditEntry } from './audit';
import { seedApprovals, seedAudit } from './auditSeed';
import { seedConfig, seedFlags, type BankConfig, type FeatureFlag } from './configSeed';
import { seedCustomers, type CustomerRecord } from './customerSeed';
import { seedDeveloper, type DeveloperState } from './developer';
import { seedDisputes, type AdminDispute } from './disputeSeed';
import { seedFraud, type FraudCase } from './fraudSeed';
import { seedKyc, type KycRecord } from './kycSeed';
import { seedLedger, type LedgerState } from './ledgerSeed';
import {
  DEFAULT_BANK_PARTNER,
  seedCards,
  type BankPartnerSettings,
  type SimCard,
  type SimCharge,
} from './simulatorSeed';
import { seedSupport, type ConversationRecord } from './supportSeed';

// The console's mock back office: staff accounts, login challenges and sessions. Data
// the pages show (customers, queues, ledger) is added by the task that builds each page.

/** Shown on the login page: this is a public demo, every account shares it. */
export const DEMO_PASSWORD = 'nem-console-demo';

export interface StaffAccount {
  staff: Staff;
  /** Base32 TOTP secret. Public on purpose in the demo; Phase 2 encrypts it at rest. */
  totpSecret: string;
  /** Last TOTP step accepted, so the same code can't be used twice. */
  lastTotpCounter: number | null;
}

export interface LoginChallenge {
  staffId: string;
  expiresAt: number;
  attempts: number;
}

export interface MockState {
  accounts: Map<string, StaffAccount>;
  challenges: Map<string, LoginChallenge>;
  /** access token → staff id */
  sessions: Map<string, string>;
  customers: Map<string, CustomerRecord>;
  /** KYC submissions by submission ID. */
  kyc: Map<string, KycRecord>;
  /** Fraud cases (held transfers) by case ID. */
  fraud: Map<string, FraudCase>;
  /** Customer disputes by dispute ID. */
  disputes: Map<string, AdminDispute>;
  /** Support chats by conversation ID. */
  support: Map<string, ConversationRecord>;
  /** The double-entry ledger behind the explorer and trial balance. */
  ledger: LedgerState;
  /** Live fees, limits, spreads and cool-off rules (ADM-8). */
  config: BankConfig;
  /** Feature flags by key, including the paid-feature toggles. */
  flags: Map<string, FeatureFlag>;
  /** Idempotency-Key → first response, for money-moving staff actions. */
  idempotency: Map<string, unknown>;
  /** Maker-checker requests (ADM-10), newest last. */
  approvals: Map<string, Schema<'ApprovalRequest'>>;
  /** The hash-chained audit log (ADM-9), oldest first; seq is the index + 1. */
  audit: AuditEntry[];
  /** Merchant and Bank Partner simulators (ADM-11). */
  simulators: {
    cards: SimCard[];
    /** Authorizations by ID, approved or declined. */
    charges: Map<string, SimCharge>;
    bankPartner: BankPartnerSettings;
  };
  /** The demo business customer's API keys and webhooks (developer portal). */
  developer: DeveloperState;
  now: () => number;
}

const account = (
  id: string,
  name: string,
  role: Staff['roles'][number],
  totpSecret: string,
  enrolled = true,
): StaffAccount => ({
  staff: {
    id: `01900000-0000-7000-8000-00000000a00${id}`,
    name,
    email: `${role}@nem.bank`,
    roles: [role],
    totp_enrolled: enrolled,
    last_login_at: enrolled ? '2026-11-02T08:12:00Z' : null,
  },
  totpSecret,
  lastTotpCounter: null,
});

export function createMockState(now: () => number = Date.now): MockState {
  const accounts = [
    account('1', 'Ifeoma Adeyemi', 'admin', 'JBSWY3DPEHPK3PXPNEMADMIN'),
    account('2', 'Aisha Bello', 'compliance', 'KRUGKIDROVUWG2ZANEMCMPL4'),
    account('3', 'Tunde Okafor', 'finance', 'MFRGGZDFMZTWQ2LKNEMFNCE4'),
    // Never signed in: the first login walks through authenticator enrolment.
    account('4', 'Chidi Eze', 'support', 'ONXXK4DPOJ2CA43VNEMSPRT5', false),
  ];
  const customers = seedCustomers();
  return {
    accounts: new Map(accounts.map((a) => [a.staff.id, a])),
    challenges: new Map(),
    sessions: new Map(),
    customers,
    kyc: seedKyc(customers),
    fraud: seedFraud(customers),
    disputes: seedDisputes(customers),
    support: seedSupport(customers, now()),
    ledger: seedLedger(customers, now()),
    config: seedConfig(),
    flags: seedFlags(),
    idempotency: new Map(),
    approvals: seedApprovals(now()),
    audit: seedAudit(),
    simulators: {
      cards: seedCards(customers),
      charges: new Map(),
      bankPartner: structuredClone(DEFAULT_BANK_PARTNER),
    },
    developer: seedDeveloper(now()),
    now,
  };
}

export function findAccountByEmail(state: MockState, email: string): StaffAccount | undefined {
  const wanted = email.trim().toLowerCase();
  return [...state.accounts.values()].find((a) => a.staff.email === wanted);
}

export function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}
