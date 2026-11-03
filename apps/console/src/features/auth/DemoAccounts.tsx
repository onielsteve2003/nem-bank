import { DEMO_PASSWORD } from '@/data/mock/state';

const DEMO_ACCOUNTS = [
  { email: 'admin@nem.bank', role: 'Admin', note: 'Everything' },
  { email: 'compliance@nem.bank', role: 'Compliance', note: 'KYC, fraud, audit' },
  { email: 'finance@nem.bank', role: 'Finance', note: 'Ledger, config' },
  { email: 'support@nem.bank', role: 'Support', note: 'First login: authenticator setup' },
];

/** Demo only: one tap fills a seeded staff account. */
export function DemoAccounts({ onPick }: { onPick: (email: string) => void }) {
  return (
    <section className="card stack" aria-labelledby="demo-accounts">
      <h2 id="demo-accounts">Demo accounts</h2>
      <p className="muted">
        Password for all: <code className="num">{DEMO_PASSWORD}</code>
      </p>
      <ul className="demo-list">
        {DEMO_ACCOUNTS.map((a) => (
          <li key={a.email}>
            <button
              type="button"
              className="btn btn-ghost demo-pick"
              onClick={() => onPick(a.email)}
            >
              <span>
                <strong>{a.role}</strong> <span className="muted">{a.email}</span>
              </span>
              <span className="muted">{a.note}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
