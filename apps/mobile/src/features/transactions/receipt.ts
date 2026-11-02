import type { Schema } from '@nem/contracts';
import { add, formatMoney } from '@nem/shared';

import { STATUS_META } from '@/components/StatusPill';
import { fromApiMoney } from '@/lib/money';
import { escapeHtml } from '@/lib/shareHtml';

import { formatDateTime } from './format';
import i18n from '@/lib/i18n';

type Receipt = Schema<'Receipt'>;

export type ReceiptLine = { label: string; value: string };

/** The receipt's lines in the order both the in-app card and the PDF show them. */
export function receiptLines(r: Receipt): ReceiptLine[] {
  const amount = fromApiMoney(r.amount);
  const fee = fromApiMoney(r.fee);
  const party = (p: Schema<'ReceiptParty'>) =>
    `${p.name}\n${p.bank_name} · ${p.account_number_masked}`;
  return [
    { label: i18n.t('receipt.lines.from'), value: party(r.from) },
    { label: i18n.t('receipt.lines.to'), value: party(r.to) },
    ...(r.narration ? [{ label: i18n.t('receipt.lines.narration'), value: r.narration }] : []),
    { label: i18n.t('receipt.lines.amount'), value: formatMoney(amount) },
    { label: i18n.t('receipt.lines.fee'), value: formatMoney(fee) },
    // Both are in the transaction's currency; add() throws if that ever changes.
    { label: i18n.t('receipt.lines.total'), value: formatMoney(add(amount, fee)) },
    { label: i18n.t('receipt.lines.date'), value: formatDateTime(r.created_at) },
    ...(r.completed_at
      ? [{ label: i18n.t('receipt.lines.completed'), value: formatDateTime(r.completed_at) }]
      : []),
    { label: i18n.t('receipt.lines.reference'), value: r.reference },
    { label: i18n.t('receipt.lines.verificationCode'), value: r.verification_code },
  ];
}

export const receiptFileTitle = (r: Receipt) =>
  i18n.t('receipt.fileTitle', { reference: r.reference });

/** A self-contained, print-ready HTML receipt (fonts and colours inline, no assets). */
export function receiptHtml(r: Receipt): string {
  const rows = receiptLines(r)
    .map(
      (l) =>
        `<tr><th>${escapeHtml(l.label)}</th><td>${escapeHtml(l.value).replace(/\n/g, '<br>')}</td></tr>`,
    )
    .join('');
  const status = STATUS_META[r.status].label;
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(receiptFileTitle(r))}</title>
<style>
  @page { margin: 24mm 18mm; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 0; }
  .brand { font-weight: 700; font-size: 20px; letter-spacing: -0.02em; }
  .brand span { background: #d4ff3a; padding: 2px 8px; border-radius: 6px; }
  h1 { font-size: 28px; margin: 24px 0 4px; }
  .status { display: inline-block; font-weight: 600; border: 1px solid #111; border-radius: 999px; padding: 2px 10px; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 24px; font-size: 13px; }
  th { text-align: left; font-weight: 500; color: #555; width: 38%; vertical-align: top; }
  th, td { padding: 10px 0; border-bottom: 1px solid #e5e5e5; }
  td { text-align: right; }
  .note { margin-top: 28px; font-size: 11px; color: #666; line-height: 1.5; }
</style></head>
<body>
  <div class="brand"><span>Nem</span> Bank</div>
  <h1>${escapeHtml(formatMoney(fromApiMoney(r.amount)))}</h1>
  <div class="status">${escapeHtml(status)}</div>
  <table>${rows}</table>
  <p class="note">${escapeHtml(i18n.t('receipt.note'))}</p>
</body></html>`;
}
