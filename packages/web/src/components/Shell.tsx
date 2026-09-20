import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useProfile } from '../state/ProfileContext';
import { api, type HealthInfo } from '../lib/api';

/**
 * Application shell: sidebar navigation, top bar, and the always-visible
 * synthetic-data notice.
 *
 * The engine badge in the top bar is deliberate. The platform runs with Claude
 * on Bedrock, the direct Claude API, or no model at all, and which one is
 * active changes how the assistant answers - so it is stated rather than
 * hidden.
 */

const ICONS = {
  dashboard: 'M3 13h8V3H3v10Zm10 8h8V11h-8v10ZM3 21h8v-6H3v6Zm10-12h8V3h-8v6Z',
  goals: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 3a2 2 0 1 1 0 4 2 2 0 0 1 0-4Z',
  scenarios: 'M3 17l6-6 4 4 8-8M21 7h-5m5 0v5',
  portfolio: 'M3 3v18h18M7 15v3M12 9v9M17 5v13',
  actions: 'M13 2 4 14h6l-1 8 9-12h-6l1-8Z',
  assistant: 'M4 4h16v11H9l-5 4V4Z',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4 0-7 2-7 4.5V21h14v-2.5C19 16 16 14 12 14Z',
  assumptions: 'M12 2 2 7l10 5 10-5-10-5Zm0 20 10-5V9l-10 5-10-5v8l10 5Z',
} as const;

function Icon({ path, filled = false }: { path: string; filled?: boolean }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: ICONS.dashboard, filled: true, group: 'Overview' },
  { to: '/actions', label: 'Next Best Actions', icon: ICONS.actions, filled: true, group: 'Overview' },
  { to: '/goals', label: 'Goals', icon: ICONS.goals, filled: true, group: 'Plan' },
  { to: '/scenarios', label: 'Scenario Lab', icon: ICONS.scenarios, filled: false, group: 'Plan' },
  { to: '/portfolio', label: 'Portfolio', icon: ICONS.portfolio, filled: false, group: 'Plan' },
  { to: '/assistant', label: 'AI Assistant', icon: ICONS.assistant, filled: false, group: 'Intelligence' },
  { to: '/assumptions', label: 'Assumptions', icon: ICONS.assumptions, filled: true, group: 'Intelligence' },
  { to: '/profile', label: 'My Details', icon: ICONS.profile, filled: true, group: 'Settings' },
] as const;

const ENGINE_LABEL: Record<HealthInfo['engine'], { text: string; tone: string; title: string }> = {
  bedrock: {
    text: 'Claude on Bedrock',
    tone: 'badge-positive',
    title: 'Reasoning runs on Claude via Amazon Bedrock, using the Lambda execution role - no API key is stored anywhere.',
  },
  anthropic: {
    text: 'Claude API',
    tone: 'badge-info',
    title: 'Reasoning runs on Claude via the Anthropic API.',
  },
  deterministic: {
    text: 'Deterministic engine',
    tone: 'badge-warning',
    title:
      'No model credentials are configured, so the agent is planning and answering with its rule-based engine. Every feature works; the wording is less fluent.',
  },
};

export function Shell({ children, title }: { children: ReactNode; title: string }) {
  const { profile, snapshot, theme, toggleTheme, saveState, switchCurrency, reset } = useProfile();
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  // Close the mobile drawer on navigation, or it covers the page you just opened.
  useEffect(() => setNavOpen(false), [location.pathname]);

  const urgentActions = snapshot?.actions.filter((a) => a.priorityScore >= 70).length ?? 0;
  const groups = [...new Set(NAV.map((n) => n.group))];
  const engine = health ? ENGINE_LABEL[health.engine] : null;

  return (
    <div className="app-shell">
      {navOpen && (
        <button className="sidebar-backdrop" onClick={() => setNavOpen(false)} aria-label="Close navigation" />
      )}
      <aside className={`sidebar ${navOpen ? 'open' : ''}`.trim()}>
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 17l6-7 4 4 8-9" />
            </svg>
          </div>
          <div>
            <div className="brand-name">Wealth Navigator</div>
            <div className="brand-sub">AI Financial Wellness</div>
          </div>
        </div>

        <nav className="stack-sm" aria-label="Main">
          {groups.map((group) => (
            <div className="nav-group" key={group}>
              <div className="nav-label">{group}</div>
              {NAV.filter((n) => n.group === group).map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                >
                  <Icon path={item.icon} filled={item.filled} />
                  {item.label}
                  {item.to === '/actions' && urgentActions > 0 && (
                    <span className="nav-badge" title={`${urgentActions} high-priority actions`}>
                      {urgentActions}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div style={{ marginTop: 'auto' }} className="stack-sm">
          {engine && (
            <div className="card" style={{ padding: 11 }} title={engine.title}>
              <div className="stat-label" style={{ marginBottom: 5 }}>
                Reasoning engine
              </div>
              <span className={`badge ${engine.tone}`}>{engine.text}</span>
              {health?.model && (
                <div className="text-xs text-subtle num" style={{ marginTop: 5 }}>
                  {health.model}
                </div>
              )}
            </div>
          )}
          {profile && (
            <button className="btn btn-ghost btn-sm" onClick={reset} title="Return to the start screen and pick a different profile">
              Switch profile
            </button>
          )}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button
            className="btn btn-icon btn-ghost"
            onClick={() => setNavOpen((o) => !o)}
            aria-label="Toggle navigation"
            style={{ display: 'none' }}
            data-mobile-toggle
          >
            <svg width="18" height="18" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
          <span className="topbar-title">{title}</span>
          <span className="topbar-spacer" />

          {saveState === 'saving' && (
            <span className="text-xs text-subtle row" style={{ gap: 6 }}>
              <span className="spinner" /> Saving
            </span>
          )}
          {saveState === 'saved' && <span className="text-xs text-positive">✓ Saved</span>}
          {saveState === 'error' && (
            <span className="text-xs text-negative" title="Your changes are safe locally but could not be saved to the server">
              ⚠ Not saved
            </span>
          )}

          {profile && (
            <div className="switch" role="group" aria-label="Display currency">
              {(['INR', 'USD'] as const).map((c) => (
                <button
                  key={c}
                  aria-pressed={profile.currency === c}
                  onClick={() => switchCurrency(c)}
                  title={`Show amounts in ${c}${c === 'USD' ? ' (converted at an illustrative fixed rate)' : ''}`}
                >
                  {c === 'INR' ? '₹ INR' : '$ USD'}
                </button>
              ))}
            </div>
          )}

          <button
            className="btn btn-icon btn-ghost"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-13V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m0-11.4L4.9 4.9m14.2 14.2-1.4-1.4" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10Z" />
              </svg>
            )}
          </button>
        </header>

        {profile?.isSynthetic && (
          <div className="synthetic-banner">
            Synthetic demonstration data · illustrative projections, not financial advice
          </div>
        )}

        <main className="page">{children}</main>
      </div>

      {/* The hamburger only exists below the layout breakpoint. Driving it from
          CSS keeps the breakpoint defined in exactly one place. */}
      <style>{`@media (max-width: 900px) { [data-mobile-toggle] { display: inline-flex !important; } }`}</style>
    </div>
  );
}
