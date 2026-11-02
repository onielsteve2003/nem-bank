import { createMockRepositories } from '..';
import { createMemoryStore } from '../persistence/types';
import { merchantKey } from '../smartCategories';

function repos() {
  return createMockRepositories({ store: createMemoryStore(), simulation: { latency: 'off' } });
}

it('keys merchants without case or extra spaces', () => {
  expect(merchantKey('  Chicken   Republic ')).toBe('chicken republic');
});

it('guesses card payments with a confidence and leaves other payments to rules', async () => {
  const r = repos();
  const page = await r.transactions.list({ query: { limit: 200 } });
  const cards = page.data.filter((t) => t.type === 'card_payment' && t.status === 'completed');
  expect(cards.length).toBeGreaterThan(0);
  for (const t of cards) {
    expect(t.category_source).toBe('model');
    expect(t.category_confidence).toBeGreaterThanOrEqual(0.5);
    expect(t.category_confidence).toBeLessThanOrEqual(1);
  }
  const bolt = cards.filter((t) => t.counterparty.name === 'Bolt');
  expect(new Set(bolt.map((t) => t.category_confidence)).size).toBe(1);
  expect(bolt[0]!.category_confidence).toBeGreaterThanOrEqual(0.9);
  const other = page.data.find((t) => t.type !== 'card_payment')!;
  expect(other.category_source).toBe('rules');
  expect(other.category_confidence ?? null).toBeNull();
});

it('uses rules when smart categories is off', async () => {
  const r = repos();
  const prefs = await r.users.getPreferences();
  await r.users.setPreferences({
    body: { ...prefs, ai: { ...prefs.ai, smart_categories: false } },
  });
  const page = await r.transactions.list({ query: { type: ['card_payment'], limit: 50 } });
  expect(page.data.every((t) => t.category_source === 'rules')).toBe(true);
});

it('applies a merchant rule to past payments, and one-off corrections win over it', async () => {
  const r = repos();
  const page = await r.transactions.list({ query: { type: ['card_payment'], limit: 200 } });
  const [first, second] = page.data.filter((t) => t.counterparty.name === 'Uber');
  await r.transactions.update({
    path: { transaction_id: second!.id },
    body: { category: 'food', apply_to_similar: false },
  });
  await r.transactions.update({
    path: { transaction_id: first!.id },
    body: { category: 'shopping', apply_to_similar: true },
  });
  const uber = (
    await r.transactions.list({ query: { type: ['card_payment'], limit: 200 } })
  ).data.filter((t) => t.counterparty.name === 'Uber');
  // The rule replaced the earlier one-off correction too.
  expect(uber.every((t) => t.category === 'shopping' && t.category_source === 'user')).toBe(true);

  await r.transactions.update({
    path: { transaction_id: first!.id },
    body: { category: 'transport', apply_to_similar: false },
  });
  const one = await r.transactions.get({ path: { transaction_id: first!.id } });
  const other = await r.transactions.get({ path: { transaction_id: second!.id } });
  expect(one.category).toBe('transport');
  expect(other.category).toBe('shopping');
});
