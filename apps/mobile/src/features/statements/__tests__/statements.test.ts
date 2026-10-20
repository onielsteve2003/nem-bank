import type { Schema } from '@nem/contracts';

import { qrPath, qrSvg } from '@/lib/qr';

import { periodRange, statementHtml, statementTotals } from '../statements';

const statement: Schema<'Statement'> = {
  id: '00000000-0000-4000-8000-000000000002',
  account_id: '00000000-0000-4000-8000-000000000003',
  currency: 'NGN',
  period_from: '2026-09-01',
  period_to: '2026-09-30',
  status: 'ready',
  opening_balance: { amount_minor: '10000000', currency: 'NGN' },
  closing_balance: { amount_minor: '9050000', currency: 'NGN' },
  sha256: 'a'.repeat(64),
  verification_code: 'ABCDEF123456',
  verification_url: 'https://nem-bank-fodx.vercel.app/verify/ABCDEF123456',
  created_at: '2026-10-20T10:00:00Z',
};

const line = (direction: 'credit' | 'debit', minor: string, name: string): Schema<'Transaction'> =>
  ({
    id: `t-${minor}`,
    account_id: statement.account_id,
    type: direction === 'credit' ? 'transfer_in' : 'transfer_out',
    direction,
    status: 'completed',
    amount: { amount_minor: minor, currency: 'NGN' },
    fee: null,
    balance_after: { amount_minor: '9050000', currency: 'NGN' },
    narration: name,
    reference: `REF${minor}`,
    category: 'other',
    category_source: 'rules',
    counterparty: { name },
    transfer_id: null,
    card_id: null,
    created_at: '2026-09-10T12:00:00Z',
  }) as Schema<'Transaction'>;

it('works out preset periods on the Lagos calendar', () => {
  expect(periodRange('last_month', '2026-10-20')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  expect(periodRange('last_month', '2026-01-05')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  expect(periodRange('m3', '2026-10-20')).toEqual({ from: '2026-07-21', to: '2026-10-20' });
  expect(periodRange('m12', '2026-10-20')).toEqual({ from: '2025-10-21', to: '2026-10-20' });
});

it('totals money in and out in minor units', () => {
  const totals = statementTotals(statement, [
    line('credit', '5000000', 'Salary'),
    line('debit', '5950000', 'Rent'),
  ]);
  expect(totals).toEqual({ moneyIn: '₦50,000.00', moneyOut: '₦59,500.00' });
});

it('prints the hash, code and a QR on the statement and escapes names', () => {
  const html = statementHtml(
    statement,
    { name: 'Tolu <b>Adebayo</b>', account: '****1234', bankName: 'Nem Bank (demo)' },
    [line('debit', '100', 'A & B')],
  );
  expect(html).toContain('a'.repeat(64));
  expect(html).toContain('ABCDEF123456');
  expect(html).toContain('<svg');
  expect(html).toContain('Tolu &lt;b&gt;Adebayo&lt;/b&gt;');
  expect(html).toContain('not a real bank document');
});

it('draws a square QR with the quiet zone', () => {
  const { size, d } = qrPath(statement.verification_url!);
  expect(size).toBeGreaterThanOrEqual(21);
  expect((size - 17) % 4).toBe(0);
  expect(d.startsWith('M0 0')).toBe(true); // finder pattern corner is dark
  expect(qrSvg('x', 72)).toContain('viewBox="-4 -4');
});
