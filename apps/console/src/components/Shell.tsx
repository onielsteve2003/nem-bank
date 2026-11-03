import { Link, Outlet } from '@tanstack/react-router';

import { ThemeSelect } from './ThemeSelect';

export function Shell() {
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
            Overview
          </Link>
        </nav>
      </aside>
      <div className="main">
        <p className="demo-banner">
          Demo console: simulated bank data, no real customers or money.
        </p>
        <header className="topbar">
          <span className="muted">Staff back office</span>
          <div className="topbar-actions">
            <ThemeSelect />
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
