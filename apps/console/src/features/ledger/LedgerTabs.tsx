import { Link } from '@tanstack/react-router';

/** The ledger's four views, as links so each one has its own URL. */
export function LedgerTabs() {
  return (
    <nav className="tabs" aria-label="Ledger views">
      <Link to="/ledger" search={{}} className="tab" activeOptions={{ exact: true }}>
        Journal
      </Link>
      <Link to="/ledger/accounts" search={{}} className="tab">
        Accounts
      </Link>
      <Link to="/ledger/trial-balance" search={{}} className="tab">
        Trial balance
      </Link>
      <Link to="/ledger/reconciliation" search={{}} className="tab">
        Reconciliation
      </Link>
    </nav>
  );
}
