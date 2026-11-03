import { Link, Outlet } from '@tanstack/react-router';

import { ThemeSelect } from '@/components/ThemeSelect';

/** The developer portal's own frame: a business customer's view, not the back office. */
export function DeveloperShell() {
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
          Sandbox: signed in as the demo business Dayo&apos;s Store. Keys start with nem_test_ and
          only reach the sandbox.
        </p>
        <header className="topbar">
          <ThemeSelect />
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
