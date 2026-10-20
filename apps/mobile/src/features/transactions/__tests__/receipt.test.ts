import type { Schema } from '@nem/contracts';

import { receiptHtml, receiptLines } from '../receipt';

const receipt: Schema<'Receipt'> = {
  transaction_id: '00000000-0000-4000-8000-000000000001',
  reference: 'NEM2026102000001',
  status: 'completed',
  amount: { amount_minor: '1500050', currency: 'NGN' },
  fee: { amount_minor: '1075', currency: 'NGN' },
  from: { name: 'Tolu Adebayo', account_number_masked: '******1234', bank_name: 'Nem Bank (demo)' },
  to: {
    name: '<script>alert(1)</script>',
    account_number_masked: '******9876',
    bank_name: 'GTBank',
  },
  narration: 'Rent & bills',
  created_at: '2026-10-20T09:30:00Z',
  completed_at: '2026-10-20T09:30:00Z',
  verification_code: 'AB12CD34EF',
};

it('adds the fee to the amount in minor units', () => {
  const total = receiptLines(receipt).find((l) => l.label === 'Total')!;
  expect(total.value).toBe('₦15,011.25');
});

it('leaves out an empty narration and a missing completion time', () => {
  const labels = receiptLines({ ...receipt, narration: '', completed_at: null }).map(
    (l) => l.label,
  );
  expect(labels).not.toContain('Narration');
  expect(labels).not.toContain('Completed');
});

it('escapes names and narrations in the PDF', () => {
  const html = receiptHtml(receipt);
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('Rent &amp; bills');
  expect(html).toContain('AB12CD34EF');
  expect(html).toContain('not a real bank document');
});
