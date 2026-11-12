import { Link, Outlet, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

import { useDemoControls } from '@/data/provider';
import { canCall } from '@/features/auth/access';
import { isActive, useSession } from '@/features/auth/session';

import { StaffMenu } from './StaffMenu';
import { ThemeSelect } from './ThemeSelect';

export function Shell() {
  const demo = useDemoControls();
  const session = useSession((s) => s.session);
  const roles = session?.staff.roles ?? [];
  const router = useRouter();

  // Signed out elsewhere (a 401, sign out, expiry): go to login and come back here after.
  useEffect(() => {
    if (!isActive(session)) {
      // Read the location now rather than subscribing to it, or every step of this
      // navigation would re-run the effect and redirect again.
      void router.navigate({ to: '/login', search: { redirect: router.state.location.href } });
      return;
    }
    if (!session) return;
    const msLeft = Date.parse(session.expires_at) - Date.now();
    const timer = setTimeout(() => useSession.getState().signOut(), Math.max(msLeft, 0));
    return () => clearTimeout(timer);
  }, [session, router]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          Nem Console
        </div>
        <nav className="nav" aria-label="Main">
          <span className="nav-section">Back office</span>
          <Link to="/" className="nav-link" activeOptions={{ exact: true }}>
            Dashboard
          </Link>
          <Link to="/customers" search={{ q: '' }} className="nav-link">
            Customers
          </Link>
          {canCall(roles, 'listKycReviews') && (
            <Link to="/kyc" search={{ status: 'pending_review' }} className="nav-link">
              KYC reviews
            </Link>
          )}
          {canCall(roles, 'listFraudCases') && (
            <Link to="/fraud" search={{ status: 'active', mine: false }} className="nav-link">
              Fraud cases
            </Link>
          )}
          {canCall(roles, 'listAdminDisputes') && (
            <Link to="/disputes" search={{ status: 'active' }} className="nav-link">
              Disputes
            </Link>
          )}
          {canCall(roles, 'listAgentConversations') && (
            <Link to="/support" search={{ status: 'active', mine: false }} className="nav-link">
              Support chat
            </Link>
          )}
          {canCall(roles, 'listJournalEntries') && (
            <Link to="/ledger" search={{}} className="nav-link">
              Ledger
            </Link>
          )}
          {canCall(roles, 'getBankConfig') && (
            <Link to="/config" className="nav-link">
              Configuration
            </Link>
          )}
          {canCall(roles, 'listFeatureFlags') && (
            <Link to="/feature-flags" className="nav-link">
              Feature flags
            </Link>
          )}
          {canCall(roles, 'listApprovalRequests') && (
            <Link to="/approvals" search={{ status: 'pending' }} className="nav-link">
              Approvals
            </Link>
          )}
          {canCall(roles, 'listAuditLog') && (
            <Link to="/audit" className="nav-link">
              Audit log
            </Link>
          )}
          {canCall(roles, 'simulateCardCharge') && (
            <Link to="/simulators" className="nav-link">
              Simulators
            </Link>
          )}
          <Link to="/me" className="nav-link">
            My access
          </Link>
          <span className="nav-section">Business customers</span>
          <Link to="/developers" className="nav-link">
            Developer portal
          </Link>
        </nav>
      </aside>
      <div className="main">
        <p className="demo-banner">
          {demo
            ? 'Demo console: simulated bank data, no real customers or money.'
            : 'Sandbox console: simulated money and test customers only.'}
        </p>
        <header className="topbar">
          <ThemeSelect />
          <div className="topbar-actions">
            <StaffMenu />
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
