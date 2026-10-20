import type { Schema } from '@nem/contracts';
import { add, addDaysIso, addMonthsIso, formatMoney, negate, zero, type Money } from '@nem/shared';

import { transactionTitle } from '@/features/transactions/TransactionRow';
import { fromApiMoney } from '@/lib/money';
import { qrSvg } from '@/lib/qr';
import { escapeHtml } from '@/lib/shareHtml';

type Statement = Schema<'Statement'>;
type Transaction = Schema<'Transaction'>;

export const PERIODS = {
  last_month: 'Last month',
  m3: 'Last 3 months',
  m6: 'Last 6 months',
  m12: 'Last 12 months',
  custom: 'Choose dates',
} as const;
export type Period = keyof typeof PERIODS;

/** A preset period as inclusive Lagos dates ending on or before `today`. */
export function periodRange(period: Exclude<Period, 'custom'>, today: string) {
  if (period === 'last_month') {
    const firstOfThisMonth = `${today.slice(0, 8)}01`;
    return { from: addMonthsIso(firstOfThisMonth, -1), to: addDaysIso(firstOfThisMonth, -1) };
  }
  const months = Number(period.slice(1));
  // "Last 3 months" to 20 Oct starts on 21 Jul, so it never spans 3 months and a day.
  return { from: addDaysIso(addMonthsIso(today, -months), 1), to: today };
}

const longDate = new Intl.DateTimeFormat('en-NG', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
/** "2026-07-21" → "21 Jul 2026" (a calendar date, so no zone shift). */
export const formatDay = (iso: string) => longDate.format(new Date(`${iso}T00:00:00Z`));

export const statementTitle = (s: Pick<Statement, 'currency' | 'period_from' | 'period_to'>) =>
  `${s.currency} statement, ${formatDay(s.period_from)} to ${formatDay(s.period_to)}`;

export interface StatementHolder {
  name: string;
  /** Masked account number or IBAN: the statement may go to an embassy. */
  account: string;
  bankName: string;
}

export interface StatementTotals {
  moneyIn: string;
  moneyOut: string;
}

/** Money in and out over the lines, formatted in the statement currency. */
export function statementTotals(statement: Statement, lines: Transaction[]): StatementTotals {
  let credits: Money = zero(statement.currency);
  let debits: Money = zero(statement.currency);
  // add() throws on a line in another currency, so a mixed statement cannot add up silently.
  for (const t of lines) {
    if (t.direction === 'credit') credits = add(credits, fromApiMoney(t.amount));
    else debits = add(debits, fromApiMoney(t.amount));
  }
  return { moneyIn: formatMoney(credits), moneyOut: formatMoney(debits) };
}

/**
 * The official statement as print-ready HTML (ACC-8): holder, period, opening
 * and closing balances, every completed line, and on every page the hash and
 * a QR code that opens the public verification page.
 */
export function statementHtml(
  statement: Statement,
  holder: StatementHolder,
  lines: Transaction[],
): string {
  const e = escapeHtml;
  const money = (m: Schema<'Money'> | null | undefined) =>
    m ? e(formatMoney(fromApiMoney(m))) : '—';
  const totals = statementTotals(statement, lines);
  const rows = lines
    .map((t) => {
      const amount = fromApiMoney(t.amount);
      return `<tr><td>${e(formatDay(t.created_at.slice(0, 10)))}</td><td>${e(transactionTitle(t))}<div class="ref">${e(t.reference)}</div></td><td class="num">${e(formatMoney(t.direction === 'debit' ? negate(amount) : amount))}</td><td class="num">${money(t.balance_after)}</td></tr>`;
    })
    .join('');
  const url = statement.verification_url ?? '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(statementTitle(statement))}</title>
<style>
  @page { margin: 20mm 16mm 34mm; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 0; font-size: 12px; }
  .brand { font-weight: 700; font-size: 20px; }
  .brand span { background: #d4ff3a; padding: 2px 8px; border-radius: 6px; }
  h1 { font-size: 18px; margin: 18px 0 2px; }
  .muted { color: #555; }
  .summary { display: flex; gap: 24px; margin: 16px 0; }
  .summary div { flex: 1; border: 1px solid #e5e5e5; border-radius: 8px; padding: 8px 10px; }
  .summary b { display: block; font-size: 14px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 600; border-bottom: 1px solid #111; padding: 6px 4px; }
  td { padding: 6px 4px; border-bottom: 1px solid #eee; vertical-align: top; }
  .num { text-align: right; white-space: nowrap; }
  .ref { color: #777; font-size: 10px; }
  .verify { position: fixed; bottom: -26mm; left: 0; right: 0; display: flex; gap: 12px; align-items: center; font-size: 9px; color: #444; }
  .verify code { font-size: 8px; word-break: break-all; }
</style></head>
<body>
  <div class="brand"><span>Nem</span> Bank</div>
  <h1>Account statement</h1>
  <div class="muted">${e(formatDay(statement.period_from))} to ${e(formatDay(statement.period_to))} · ${e(statement.currency)}</div>
  <p><b>${e(holder.name)}</b><br>${e(holder.bankName)} · ${e(holder.account)}</p>
  <div class="summary">
    <div>Opening balance<b>${money(statement.opening_balance)}</b></div>
    <div>Money in<b>${e(totals.moneyIn)}</b></div>
    <div>Money out<b>${e(totals.moneyOut)}</b></div>
    <div>Closing balance<b>${money(statement.closing_balance)}</b></div>
  </div>
  <table><thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th><th class="num">Balance</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="4" class="muted">No completed transactions in this period.</td></tr>'}</tbody></table>
  <div class="verify">
    ${url ? qrSvg(url, 72) : ''}
    <div>Verify this statement at ${e(url)}<br>Verification code <b>${e(statement.verification_code ?? '')}</b><br>SHA-256 <code>${e(statement.sha256 ?? '')}</code><br>
    Nem Bank is a demo. Simulated money, not a real bank document.</div>
  </div>
</body></html>`;
}
