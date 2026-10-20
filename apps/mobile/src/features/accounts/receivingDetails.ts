import type { Schema } from '@nem/contracts';

// How to pay into each wallet (ACC-1, ACC-2), as rows a person reads aloud or
// copies, and as one message to share. Display formatting never reaches the
// copied value: banks want digits only.

export type ReceivingDetails = Schema<'ReceivingDetails'>;

export interface DetailRow {
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

const row = (label: string, value: string, copy = value): DetailRow => ({ label, value, copy });

/** The rows for one wallet, most-asked-for first. */
export function detailRows(details: ReceivingDetails): DetailRow[] {
  switch (details.scheme) {
    case 'nuban':
      return [
        row('Account number', details.account_number),
        row('Bank', details.bank_name),
        row('Account name', details.account_name),
      ];
    case 'us_ach':
      return [
        row('Account number', details.account_number),
        row('Routing number (ACH)', details.routing_number),
        row('Account type', 'Checking'),
        row('Bank', details.bank_name),
        row('Account name', details.account_name),
      ];
    case 'uk_fps':
      return [
        row('Sort code', formatSortCode(details.sort_code), details.sort_code.replace(/\D/g, '')),
        row('Account number', details.account_number),
        row('Bank', details.bank_name),
        row('Account name', details.account_name),
      ];
    case 'iban':
      return [
        row('IBAN', formatIban(details.iban), details.iban.replace(/\s/g, '').toUpperCase()),
        row('BIC / SWIFT', details.bic),
        row('Bank', details.bank_name),
        row('Account name', details.account_name),
      ];
  }
}

/** One message with every detail, for WhatsApp, email or a payslip form. */
export function shareMessage(details: ReceivingDetails, currencyName: string): string {
  const lines = detailRows(details).map((r) => `${r.label}: ${r.value}`);
  const note = details.demo
    ? ['', 'These are demo details from the Nem Bank demo, not a real account.']
    : [];
  return [`My ${currencyName} account details`, ...lines, ...note].join('\n');
}
