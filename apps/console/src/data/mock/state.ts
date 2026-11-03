import type { Staff } from '@nem/contracts';

// The console's mock back office: staff accounts and the signed-in session. Data the
// pages show (customers, queues, ledger) is added by the task that builds each page.

export const DEMO_STAFF: readonly Staff[] = [
  {
    id: '01900000-0000-7000-8000-00000000a001',
    name: 'Ifeoma Adeyemi',
    email: 'admin@nem.bank',
    roles: ['admin'],
    totp_enrolled: true,
    last_login_at: '2026-11-02T08:12:00Z',
  },
  {
    id: '01900000-0000-7000-8000-00000000a002',
    name: 'Aisha Bello',
    email: 'compliance@nem.bank',
    roles: ['compliance'],
    totp_enrolled: true,
    last_login_at: '2026-11-02T09:40:00Z',
  },
  {
    id: '01900000-0000-7000-8000-00000000a003',
    name: 'Tunde Okafor',
    email: 'finance@nem.bank',
    roles: ['finance'],
    totp_enrolled: true,
    last_login_at: '2026-11-01T16:05:00Z',
  },
  {
    id: '01900000-0000-7000-8000-00000000a004',
    name: 'Chidi Eze',
    email: 'support@nem.bank',
    roles: ['support'],
    totp_enrolled: true,
    last_login_at: '2026-11-02T07:58:00Z',
  },
];

export interface MockState {
  /** The staff member the mock treats as signed in, or null. */
  session: Staff | null;
}

export function createMockState(): MockState {
  return { session: DEMO_STAFF[0] ?? null };
}
