import { Link, Outlet } from '@tanstack/react-router';

import { ThemeSelect } from '@/components/ThemeSelect';
import { useDemoControls } from '@/data/provider';

import { useDeveloperSession } from './developerSession';
import { DeveloperSignIn } from './DeveloperSignIn';
import { useDeveloperSignOut } from './useDeveloper';

/** The developer portal's own frame: a business customer's view, not the back office. */
export function DeveloperShell() {
  const demo = useDemoControls();
  const session = useDeveloperSession((s) => s.session);
  const signOut = useDeveloperSignOut();

  // The mock portal is always "signed in" as the demo business; the real one needs a customer.
  if (!demo && !session) return <DeveloperSignIn />;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            N
          </span>
          Nem for Developers
        </div>
        <nav className="nav" aria-label="Developer">
          <span className="nav-section">Sandbox</span>
          <Link to="/developers" className="nav-link" activeOptions={{ exact: true }}>
            API keys
          </Link>
          <Link to="/developers/webhooks" className="nav-link">
            Webhooks
          </Link>
          <a href="/api-reference.html" className="nav-link" target="_blank" rel="noreferrer">
            API reference ↗
          </a>
          <span className="nav-section">Nem Bank</span>
          <Link to="/" className="nav-link">
            Staff console
          </Link>
        </nav>
      </aside>
      <div className="main">
        <p className="demo-banner">
          {demo
            ? "Sandbox: signed in as the demo business Dayo's Store. Keys start with nem_test_ and only reach the sandbox."
            : 'Sandbox: keys start with nem_test_ and only reach the sandbox.'}
        </p>
        <header className="topbar">
          <ThemeSelect />
          {session && (
            <div className="topbar-actions">
              <span className="muted">{session.user.email}</span>
              <button type="button" className="btn btn-small" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          )}
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
