import { Badge } from '@/components/Badge';
import { MoneyText } from '@/components/MoneyText';
import { formatDateTime } from '@/lib/dates';

import type { Customer360 } from './types';

type Props = { data: Customer360 };

const KYC_STATUS: Readonly<Record<Customer360['kyc']['status'], string>> = {
  not_started: 'Not started',
  pending_review: 'Waiting for review',
  approved: 'Approved',
  rejected: 'Rejected',
  resubmit: 'Asked to resubmit',
};

export function ProfileSection({ data }: Props) {
  const { customer, kyc, panic, open_cases } = data;
  return (
    <section className="card stack" aria-labelledby="profile-title">
      <h2 id="profile-title">Profile</h2>
      <dl className="facts">
        <dt>Email</dt>
        <dd>{customer.email_masked}</dd>
        <dt>Phone</dt>
        <dd>{customer.phone_masked}</dd>
        <dt>Date of birth</dt>
        <dd>{data.date_of_birth ?? <span className="muted">Hidden for your role</span>}</dd>
        <dt>Joined</dt>
        <dd>{formatDateTime(customer.created_at)}</dd>
        <dt>KYC</dt>
        <dd>
          Tier {kyc.tier} · {KYC_STATUS[kyc.status]}
        </dd>
        <dt>Panic button</dt>
        <dd>
          {panic.active ? (
            <Badge tone="danger">
              On since {panic.activated_at ? formatDateTime(panic.activated_at) : '—'} ·{' '}
              {panic.cards_frozen} cards frozen
            </Badge>
          ) : (
            'Off'
          )}
        </dd>
        <dt>Open cases</dt>
        <dd>
          {open_cases.fraud} fraud · {open_cases.disputes} disputes · {open_cases.support} support
        </dd>
      </dl>
    </section>
  );
}

export function AccountsSection({ data }: Props) {
  return (
    <section className="card stack" aria-labelledby="accounts-title">
      <h2 id="accounts-title">Accounts</h2>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Account</th>
            <th scope="col">Status</th>
            <th scope="col" className="numeric">
              Available
            </th>
            <th scope="col" className="numeric">
              Ledger
            </th>
          </tr>
        </thead>
        <tbody>
          {data.accounts.map((a) => (
            <tr key={a.id}>
              <td>
                {a.currency} {a.kind === 'ngn_current' ? 'current' : 'wallet'}
                {'account_number' in a.receiving_details && (
                  <span className="muted num"> · {a.receiving_details.account_number}</span>
                )}
              </td>
              <td>
                <Badge tone={a.status === 'active' ? 'success' : 'danger'}>{a.status}</Badge>
              </td>
              <td className="numeric">
                <MoneyText value={a.available_balance} />
              </td>
              <td className="numeric">
                <MoneyText value={a.ledger_balance} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function DevicesSection({ data }: Props) {
  return (
    <section className="card stack" aria-labelledby="devices-title">
      <h2 id="devices-title">Devices</h2>
      {data.devices.length === 0 ? (
        <p className="muted">No devices bound.</p>
      ) : (
        <ul className="note-list">
          {data.devices.map((d) => (
            <li key={d.id}>
              <p className="row">
                <strong>{d.name}</strong>
                <Badge tone={d.trusted ? 'success' : 'warning'}>
                  {d.trusted ? 'Trusted' : 'Cool-off'}
                </Badge>
                {d.hardware_backed && <Badge>Hardware key</Badge>}
              </p>
              <span className="muted hint">
                {d.location_hint ?? 'Unknown location'} · last seen {formatDateTime(d.last_seen_at)}{' '}
                · key <span className="num">{d.key_fingerprint}</span>
                {d.cool_off_until && ` · cool-off until ${formatDateTime(d.cool_off_until)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function TransactionsSection({ data }: Props) {
  return (
    <section className="card stack" aria-labelledby="tx-title">
      <h2 id="tx-title">Recent transactions</h2>
      {data.recent_transactions.length === 0 ? (
        <p className="muted">No transactions yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Description</th>
              <th scope="col">Reference</th>
              <th scope="col" className="numeric">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {data.recent_transactions.map((t) => (
              <tr key={t.id}>
                <td className="muted">{formatDateTime(t.created_at)}</td>
                <td>{t.narration}</td>
                <td className="muted num">{t.reference}</td>
                <td className="numeric">
                  <span className="sr-only">{t.direction === 'credit' ? 'In' : 'Out'}</span>
                  <MoneyText
                    value={
                      t.direction === 'debit'
                        ? { ...t.amount, amount_minor: `-${t.amount.amount_minor}` }
                        : t.amount
                    }
                    signPositive
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
