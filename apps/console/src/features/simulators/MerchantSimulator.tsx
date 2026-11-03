import { parseMajor } from '@nem/shared';
import { useState, type FormEvent } from 'react';

import { Badge } from '@/components/Badge';
import { MoneyText } from '@/components/MoneyText';
import { isApiError } from '@/data/errors';
import { useDemoControls, type TestCard } from '@/data/provider';

import { useChargeCard, useSettleCharge, type CardTransaction } from './useSimulators';

const MERCHANTS = [
  { id: 'shoprite-lekki', name: 'Shoprite Lekki', mcc: '5411', country: 'NG', currency: 'NGN' },
  { id: 'bolt', name: 'Bolt', mcc: '4121', country: 'NG', currency: 'NGN' },
  { id: 'jumia', name: 'Jumia', mcc: '5311', country: 'NG', currency: 'NGN' },
  { id: 'netflix', name: 'Netflix', mcc: '4899', country: 'US', currency: 'USD' },
  { id: 'amazon', name: 'Amazon', mcc: '5942', country: 'US', currency: 'USD' },
] as const;

const DECLINES: Readonly<Record<NonNullable<CardTransaction['decline_reason']>, string>> = {
  insufficient_funds: 'Not enough money in the account',
  card_frozen: 'The card or the customer is frozen',
  limit_exceeded: "Over the card's spend limit",
  online_disabled: 'Online payments are off for this card',
  international_disabled: 'International payments are off for this card',
  merchant_not_allowed: 'The card is locked to another merchant',
  card_used: 'This single-use card was already used',
};

const STATUS_TONE = {
  authorized: 'warning',
  settled: 'success',
  reversed: 'neutral',
  declined: 'danger',
} as const;

function Result({ tx }: { tx: CardTransaction }) {
  return (
    <div className="proof card stack tight" data-balanced={tx.status !== 'declined'} role="status">
      <p className="row">
        <Badge tone={STATUS_TONE[tx.status]}>
          {tx.status === 'declined' ? 'Declined' : tx.status === 'settled' ? 'Settled' : 'Approved'}
        </Badge>
        <span>
          <MoneyText value={tx.amount} /> at {tx.merchant.name}
          {tx.billing_amount.currency !== tx.amount.currency && (
            <>
              {' '}
              (billed <MoneyText value={tx.billing_amount} />)
            </>
          )}
        </span>
      </p>
      <p className="muted">
        {tx.decline_reason
          ? DECLINES[tx.decline_reason]
          : tx.status === 'settled'
            ? 'Settled at once: the money left the account and posted to card settlement.'
            : 'A hold is on the account. Capture it to settle, or reverse it to release the hold.'}
      </p>
    </div>
  );
}

export function MerchantSimulator() {
  const demo = useDemoControls();
  const [cards, setCards] = useState<TestCard[]>(() => demo?.testCards() ?? []);
  const [cardId, setCardId] = useState(cards[0]?.id ?? '');
  const [merchantId, setMerchantId] = useState<string>(MERCHANTS[0].id);
  const [amount, setAmount] = useState('');
  const [channel, setChannel] = useState<'online' | 'in_store'>('online');
  const [capture, setCapture] = useState(false);
  const [history, setHistory] = useState<CardTransaction[]>([]);
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const charge = useChargeCard();
  const settle = useSettleCharge();

  const card = cards.find((c) => c.id === cardId);
  const merchant = MERCHANTS.find((m) => m.id === merchantId)!;
  let parsed: ReturnType<typeof parseMajor> | null = null;
  try {
    parsed = amount.trim() ? parseMajor(amount.trim(), merchant.currency) : null;
  } catch {
    parsed = null;
  }
  const valid = card !== undefined && parsed !== null && parsed.amount > 0n;

  const remember = (tx: CardTransaction) => {
    setHistory((h) => [tx, ...h.filter((t) => t.id !== tx.id)]);
    // A used single-use card shows as used in the picker.
    if (demo) setCards(demo.testCards());
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    charge.mutate(
      {
        idempotencyKey,
        body: {
          pan: card.pan,
          cvv: card.cvv,
          expiry_month: card.expiryMonth,
          expiry_year: card.expiryYear,
          amount: { amount_minor: parsed!.amount.toString(), currency: merchant.currency },
          merchant: {
            id: merchant.id,
            name: merchant.name,
            mcc: merchant.mcc,
            country: merchant.country,
          },
          channel,
          capture,
        },
      },
      {
        onSuccess: (tx) => {
          remember(tx);
          setIdempotencyKey(crypto.randomUUID());
        },
      },
    );
  };

  return (
    <section className="card stack" aria-labelledby="merchant-title">
      <div className="stack tight">
        <h2 id="merchant-title">Merchant Simulator</h2>
        <p className="muted">
          Charge a customer's virtual card as a merchant would. The authorization runs the same
          checks as the card processor: card state, controls, limits and balance.
        </p>
      </div>

      <form className="stack" onSubmit={submit} aria-label="Charge a card">
        <label className="field">
          Test card
          <select className="select" value={cardId} onChange={(e) => setCardId(e.target.value)}>
            {cards.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}: {c.purpose}
              </option>
            ))}
          </select>
        </label>
        {card && (
          <p className="muted hint num">
            {card.pan.replace(/(\d{4})(?=\d)/g, '$1 ')} ·{' '}
            {String(card.expiryMonth).padStart(2, '0')}/{String(card.expiryYear).slice(-2)} · CVV{' '}
            {card.cvv}
          </p>
        )}
        <div className="row filters">
          <label className="field">
            Merchant
            <select
              className="select"
              value={merchantId}
              onChange={(e) => setMerchantId(e.target.value)}
            >
              {MERCHANTS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.country}, {m.currency})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Amount ({merchant.currency})
            <input
              className="input num"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={merchant.currency === 'NGN' ? '12,500' : '15.99'}
              aria-invalid={amount.trim() !== '' && !valid}
            />
          </label>
          <fieldset className="choices">
            <legend className="field">Channel</legend>
            <div className="segmented">
              {(['online', 'in_store'] as const).map((c) => (
                <label key={c} className="segment segment-radio">
                  <input
                    type="radio"
                    name="channel"
                    className="sr-only"
                    checked={channel === c}
                    onChange={() => setChannel(c)}
                  />
                  {c === 'online' ? 'Online' : 'In store'}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <label className="checkbox-label">
          <input type="checkbox" checked={capture} onChange={(e) => setCapture(e.target.checked)} />
          Settle at once (no authorization hold)
        </label>
        {charge.error != null && (
          <p className="field-error" role="alert">
            {isApiError(charge.error) ? charge.error.message : 'Something went wrong. Try again.'}
          </p>
        )}
        <div>
          <button type="submit" className="btn btn-primary" disabled={!valid || charge.isPending}>
            {charge.isPending ? 'Charging…' : 'Charge card'}
          </button>
        </div>
      </form>

      {charge.data && <Result tx={history.find((t) => t.id === charge.data.id) ?? charge.data} />}

      {history.length > 0 && (
        <div className="stack tight">
          <h3>This session's charges</h3>
          {settle.error != null && (
            <p className="field-error" role="alert">
              {isApiError(settle.error) ? settle.error.message : 'Something went wrong. Try again.'}
            </p>
          )}
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Merchant</th>
                <th scope="col" className="numeric">
                  Amount
                </th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {history.map((tx) => (
                <tr key={tx.id}>
                  <td>{tx.merchant.name}</td>
                  <td className="numeric">
                    <MoneyText value={tx.billing_amount} />
                  </td>
                  <td>
                    <Badge tone={STATUS_TONE[tx.status]}>{tx.status}</Badge>
                    {tx.decline_reason && (
                      <span className="muted hint"> {DECLINES[tx.decline_reason]}</span>
                    )}
                  </td>
                  <td>
                    {tx.status === 'authorized' && (
                      <span className="row">
                        {(['capture', 'reverse'] as const).map((action) => (
                          <button
                            key={action}
                            type="button"
                            className="btn btn-small"
                            disabled={settle.isPending}
                            aria-label={`${action === 'capture' ? 'Capture' : 'Reverse'} ${tx.merchant.name}`}
                            onClick={() =>
                              settle.mutate({ id: tx.id, action }, { onSuccess: remember })
                            }
                          >
                            {action === 'capture' ? 'Capture' : 'Reverse'}
                          </button>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
