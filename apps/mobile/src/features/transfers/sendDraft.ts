import type { Schema } from '@nem/contracts';
import { create } from 'zustand';

type Beneficiary = Schema<'Beneficiary'>;
type ResolvedPayee = Schema<'ResolvedPayee'>;

export type SendMode = 'nem' | 'bank';

/** Who the money is going to, as the bank confirmed it. */
export interface DraftRecipient {
  kind: SendMode;
  name: string;
  nemtag: string | null;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  /** Set when the recipient is a saved beneficiary, so the bank can apply its history. */
  beneficiaryId: string | null;
  /** The Confirmation of Payee answer for bank transfers (TRF-3). */
  nameMatch: Schema<'NameMatch'> | null;
}

export const recipientFromBeneficiary = (b: Beneficiary): DraftRecipient => ({
  kind: b.kind,
  name: b.nickname ?? b.name,
  nemtag: b.nemtag ?? null,
  bankCode: b.bank_code,
  bankName: b.bank_name,
  accountNumber: b.account_number,
  beneficiaryId: b.id,
  nameMatch: null,
});

export const recipientFromPayee = (p: ResolvedPayee): DraftRecipient => ({
  kind: p.kind,
  name: p.name,
  nemtag: p.nemtag ?? null,
  bankCode: p.bank_code,
  bankName: p.bank_name,
  accountNumber: p.account_number,
  beneficiaryId: p.beneficiary_id ?? null,
  nameMatch: p.name_match ?? null,
});

/** The destination the transfer API expects for a confirmed recipient. */
export function destinationOf(r: DraftRecipient): Schema<'TransferDestination'> {
  if (r.beneficiaryId) return { kind: 'beneficiary', beneficiary_id: r.beneficiaryId };
  if (r.kind === 'nem') return { kind: 'nem', account_number: r.accountNumber };
  return {
    kind: 'bank',
    bank_code: r.bankCode,
    account_number: r.accountNumber,
    account_name: r.name,
  };
}

interface SendDraftState {
  recipient: DraftRecipient | null;
  /** Typed major units ("1500.5"), as AmountInput keeps it. */
  amount: string;
  narration: string;
  setRecipient: (recipient: DraftRecipient) => void;
  setAmount: (amount: string, narration: string) => void;
  clear: () => void;
}

/**
 * The transfer being put together across the send screens. Memory only: a
 * half-built payment never survives a restart, so nothing is sent by surprise
 * (ADR-10).
 */
export const useSendDraft = create<SendDraftState>()((set) => ({
  recipient: null,
  amount: '',
  narration: '',
  // A new recipient starts a new payment: the old amount was meant for someone else.
  setRecipient: (recipient) => set({ recipient, amount: '', narration: '' }),
  setAmount: (amount, narration) => set({ amount, narration }),
  clear: () => set({ recipient: null, amount: '', narration: '' }),
}));
