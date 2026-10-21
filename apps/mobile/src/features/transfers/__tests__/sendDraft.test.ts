import type { Schema } from '@nem/contracts';

import { typedFromKobo } from '../amount';
import {
  destinationOf,
  recipientFromBeneficiary,
  recipientFromPayee,
  useSendDraft,
  type DraftRecipient,
} from '../sendDraft';

const beneficiary = {
  id: 'ben-1',
  kind: 'bank',
  name: 'Tunde Bakare',
  nickname: 'Landlord',
  nemtag: null,
  bank_code: '058',
  bank_name: 'GTBank',
  account_number: '0123456789',
} as Schema<'Beneficiary'>;

const payee = {
  kind: 'bank',
  name: 'Ada Eze',
  bank_code: '044',
  bank_name: 'Access Bank',
  account_number: '0987654321',
  name_match: { result: 'match' },
} as unknown as Schema<'ResolvedPayee'>;

beforeEach(() => useSendDraft.getState().clear());

describe('recipients', () => {
  it('shows a saved beneficiary by the nickname the customer gave them', () => {
    expect(recipientFromBeneficiary(beneficiary)).toMatchObject({
      name: 'Landlord',
      beneficiaryId: 'ben-1',
      nameMatch: null,
    });
  });

  it('keeps the bank’s name check for a looked-up payee', () => {
    expect(recipientFromPayee(payee)).toMatchObject({
      name: 'Ada Eze',
      nemtag: null,
      beneficiaryId: null,
      nameMatch: { result: 'match' },
    });
  });
});

describe('destinationOf', () => {
  const base: DraftRecipient = {
    kind: 'bank',
    name: 'Ada Eze',
    nemtag: null,
    bankCode: '044',
    bankName: 'Access Bank',
    accountNumber: '0987654321',
    beneficiaryId: null,
    nameMatch: null,
  };

  it('pays a saved beneficiary by id, so the bank can apply its history', () => {
    expect(destinationOf({ ...base, beneficiaryId: 'ben-1' })).toEqual({
      kind: 'beneficiary',
      beneficiary_id: 'ben-1',
    });
  });

  it('pays a Nem user by account number only', () => {
    expect(destinationOf({ ...base, kind: 'nem' })).toEqual({
      kind: 'nem',
      account_number: '0987654321',
    });
  });

  it('sends the confirmed name with a bank transfer', () => {
    expect(destinationOf(base)).toEqual({
      kind: 'bank',
      bank_code: '044',
      account_number: '0987654321',
      account_name: 'Ada Eze',
    });
  });
});

describe('the send draft', () => {
  it('keeps the amount and note for review', () => {
    const draft = useSendDraft.getState();
    draft.setRecipient(recipientFromBeneficiary(beneficiary));
    draft.setAmount('2500.5', 'Rent');
    expect(useSendDraft.getState()).toMatchObject({ amount: '2500.5', narration: 'Rent' });
  });

  it('forgets the amount when the recipient changes, so it never goes to the wrong person', () => {
    const draft = useSendDraft.getState();
    draft.setRecipient(recipientFromBeneficiary(beneficiary));
    draft.setAmount('90000', 'Rent');
    draft.setRecipient(recipientFromPayee(payee));
    expect(useSendDraft.getState()).toMatchObject({ amount: '', narration: '' });
  });

  it('clears everything once the payment is done', () => {
    const draft = useSendDraft.getState();
    draft.setRecipient(recipientFromBeneficiary(beneficiary));
    draft.setAmount('100', '');
    draft.clear();
    expect(useSendDraft.getState()).toMatchObject({ recipient: null, amount: '', narration: '' });
  });
});

it('turns kobo back into what the keypad types', () => {
  expect(typedFromKobo(500000n)).toBe('5000');
  expect(typedFromKobo(250050n)).toBe('2500.5');
  expect(typedFromKobo(250005n)).toBe('2500.05');
});
