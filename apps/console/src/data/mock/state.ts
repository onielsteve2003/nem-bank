import type { Schema, Staff } from '@nem/contracts';

import { seedCustomers, type CustomerRecord } from './customerSeed';

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
  /** Maker-checker requests (ADM-10), newest last. */
  approvals: Map<string, Schema<'ApprovalRequest'>>;
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
  return {
    accounts: new Map(accounts.map((a) => [a.staff.id, a])),
    challenges: new Map(),
    sessions: new Map(),
    customers: seedCustomers(),
    approvals: new Map(),
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
