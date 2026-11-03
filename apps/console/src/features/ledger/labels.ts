import type { Schema } from '@nem/contracts';

import type { Tone } from '@/components/Badge';

import type { EntryKind } from './useLedger';

export const ENTRY_KINDS: Readonly<Record<EntryKind, string>> = {
  transfer_internal: 'Transfer (Nem to Nem)',
  transfer_external: 'Transfer (other bank)',
  transfer_reversal: 'Transfer reversal',
  fee: 'Fee',
  levy: 'Levy',
  fx_conversion: 'FX conversion',
  card_authorization: 'Card authorization',
  card_settlement: 'Card settlement',
  card_reversal: 'Card reversal',
  bill_payment: 'Bill payment',
  savings: 'Savings',
  interest_accrual: 'Interest accrual',
  ajo_contribution: 'Ajo contribution',
  ajo_payout: 'Ajo payout',
  loan_disbursement: 'Loan disbursement',
  loan_repayment: 'Loan repayment',
  dispute_refund: 'Dispute refund',
  demo_funding: 'Demo funding',
  manual_adjustment: 'Manual adjustment',
};

export const RECON_STATUS: Readonly<
  Record<Schema<'ReconciliationItem'>['status'], [label: string, tone: Tone]>
> = {
  matched: ['Matched', 'success'],
  missing_in_ledger: ['Missing in ledger', 'danger'],
  missing_at_partner: ['Missing at partner', 'warning'],
  amount_mismatch: ['Amount differs', 'danger'],
};
