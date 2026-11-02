import type { Schema } from '@nem/contracts';
import i18n from '@/lib/i18n';

// How to pay into each wallet (ACC-1, ACC-2), as rows a person reads aloud or
// copies, and as one message to share. Display formatting never reaches the
// copied value: banks want digits only.

export type ReceivingDetails = Schema<'ReceivingDetails'>;

export type DetailRowId =
  | 'accountNumber'
  | 'bank'
  | 'accountName'
  | 'routingNumber'
  | 'accountType'
  | 'sortCode'
  | 'iban'
  | 'bic';

export interface DetailRow {
  /** Stable across languages, for code that looks a row up. */
  id: DetailRowId;
  label: string;
  /** As shown: grouped for reading. */
  value: string;
  /** As copied: exactly what a bank form accepts. */
  copy: string;
}

const group = (text: string, size: number, separator = ' ') =>
  text.match(new RegExp(`.{1,${size}}`, 'g'))?.join(separator) ?? text;

/** "123456" → "12-34-56". */
export const formatSortCode = (code: string) => group(code.replace(/\D/g, ''), 2, '-');

/** "GB29NWBK60161331926819" → "GB29 NWBK 6016 1331 9268 19". */
export const formatIban = (iban: string) => group(iban.replace(/\s/g, '').toUpperCase(), 4);

const row = (id: DetailRowId, value: string, copy = value): DetailRow => ({
  id,
  label: i18n.t(`accounts.rows.${id}`),
  value,
  copy,
});

/** The rows for one wallet, most-asked-for first. */
export function detailRows(details: ReceivingDetails): DetailRow[] {
  switch (details.scheme) {
    case 'nuban':
      return [
        row('accountNumber', details.account_number),
        row('bank', details.bank_name),
        row('accountName', details.account_name),
      ];
    case 'us_ach':
      return [
        row('accountNumber', details.account_number),
        row('routingNumber', details.routing_number),
        row('accountType', i18n.t('accounts.rows.checking')),
        row('bank', details.bank_name),
        row('accountName', details.account_name),
      ];
    case 'uk_fps':
      return [
        row('sortCode', formatSortCode(details.sort_code), details.sort_code.replace(/\D/g, '')),
        row('accountNumber', details.account_number),
        row('bank', details.bank_name),
        row('accountName', details.account_name),
      ];
    case 'iban':
      return [
        row('iban', formatIban(details.iban), details.iban.replace(/\s/g, '').toUpperCase()),
        row('bic', details.bic),
        row('bank', details.bank_name),
        row('accountName', details.account_name),
      ];
  }
}

/** One message with every detail, for WhatsApp, email or a payslip form. */
export function shareMessage(details: ReceivingDetails, currencyName: string): string {
  const lines = detailRows(details).map((r) => `${r.label}: ${r.value}`);
  const note = details.demo ? ['', i18n.t('accounts.details.shareDemo')] : [];
  return [
    i18n.t('accounts.details.shareTitle', { currency: currencyName }),
    ...lines,
    ...note,
  ].join('\n');
}
