import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useProfile } from '../state/ProfileContext';
import { api, type HealthInfo } from '../lib/api';
import { BrandMark, Icon, type IconName } from './ui';
import { AssistantDock } from './AssistantDock';
import { CommandPalette } from './CommandPalette';

/**
 * Application shell: navigation, top bar, and the always-visible
 * synthetic-data notice.
 *
 * The engine badge is deliberate. The platform runs with Claude on Bedrock,
 * the direct Claude API, Groq, or no model at all, and which one is active
 * changes how the assistant answers - so it is stated rather than hidden.
 *
 * Below 900px the navigation is a drawer. The closed drawer is `visibility:
 * hidden` (in the stylesheet), so its links leave the tab order; Escape closes
 * it and focus returns to the button that opened it.
 */

const NAV: { to: string; label: string; icon: IconName; group: string }[] = [
  { to: '/dashboard', label: 'Dashboard', icon: 'dashboard', group: 'Overview' },
  { to: '/actions', label: 'Next Best Actions', icon: 'actions', group: 'Overview' },
  { to: '/goals', label: 'Goals', icon: 'goals', group: 'Plan' },
  { to: '/scenarios', label: 'Scenario Lab', icon: 'scenarios', group: 'Plan' },
  { to: '/portfolio', label: 'Portfolio', icon: 'portfolio', group: 'Plan' },
  { to: '/assistant', label: 'AI Assistant', icon: 'assistant', group: 'Intelligence' },
  { to: '/assumptions', label: 'Assumptions', icon: 'assumptions', group: 'Intelligence' },
  { to: '/profile', label: 'My Details', icon: 'profile', group: 'Settings' },
];

const GROUPS = [...new Set(NAV.map((n) => n.group))];

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
  groq: {
    text: 'Groq',
    tone: 'badge-info',
    title:
      'Reasoning runs on an open-weights model hosted by Groq. The tools, the finance engine and the grounding check are the same on every engine - only the wording changes.',
  },
  deterministic: {
    text: 'Deterministic engine',
    tone: 'badge-warning',
    title:
      'No model credentials are configured, so the agent is planning and answering with its rule-based engine. Every feature works; the wording is less fluent.',
  },
};

export function Shell({ children, title }: { children: ReactNode; title: string }) {
  const { profile, snapshot, theme, toggleTheme, saveState, reset } = useProfile();
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  // Close the drawer on navigation, or it covers the page you just opened.
  useEffect(() => setNavOpen(false), [location.pathname]);

  // Escape closes the drawer; focus moves into it on open and back on close.
  useEffect(() => {
    if (!navOpen) return;
    navRef.current?.querySelector<HTMLElement>('a')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNavOpen(false);
        toggleRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const urgentActions = snapshot?.actions.filter((a) => a.priorityScore >= 70).length ?? 0;
  const engine = health ? ENGINE_LABEL[health.engine] : null;

  return (
    <div className="app-shell">
      {navOpen && (
        <button
          className="sidebar-backdrop"
          onClick={() => setNavOpen(false)}
          aria-label="Close navigation"
          tabIndex={-1}
        />
      )}
      <aside id="app-nav" className={`sidebar ${navOpen ? 'open' : ''}`.trim()} ref={navRef}>
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">
            <BrandMark size={20} />
          </div>
          <div>
            <div className="brand-name">Wealth Navigator</div>
            <div className="brand-sub">Financial wellness</div>
          </div>
        </div>

        <nav className="stack-sm" aria-label="Main">
          {GROUPS.map((group) => (
            <div className="nav-group" key={group}>
              <div className="nav-label">{group}</div>
              {NAV.filter((n) => n.group === group).map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`.trim()}
                >
                  <Icon name={item.icon} size={18} />
                  <span className="truncate">{item.label}</span>
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

        <div className="sidebar-foot">
          {snapshot && (
            <div className="status-card">
              <div className="status-row">
                <span className="status-live" aria-hidden="true" />
                <span className="status-live-text">Live</span>
                {engine && (
                  <span className="status-engine" title={engine.title}>
                    {engine.text}
                  </span>
                )}
              </div>

              <div className="status-score">
                <span className="status-score-value">{snapshot.wellness.total}</span>
                <span className="status-score-grade">
                  Grade {snapshot.wellness.grade}
                  <span className="status-score-label">Wellness score</span>
                </span>
              </div>

              <div className="status-meter" aria-hidden="true">
                <span
                  className="status-meter-fill"
                  style={{ width: `${Math.max(0, Math.min(100, snapshot.wellness.total))}%` }}
                />
              </div>

              <div className="status-foot">
                {urgentActions > 0 ? (
                  <>
                    <strong className="text-warning">{urgentActions}</strong> need you now
                  </>
                ) : (
                  'Nothing urgent'
                )}
              </div>
            </div>
          )}
          {profile && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={reset}
              title="Return to the start screen and pick a different profile"
            >
              Switch profile
            </button>
          )}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button
            ref={toggleRef}
            className="btn btn-icon btn-ghost nav-toggle"
            onClick={() => setNavOpen((open) => !open)}
            aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={navOpen}
            aria-controls="app-nav"
          >
            <Icon name={navOpen ? 'close' : 'menu'} size={18} />
          </button>
          <span className="topbar-title">{title}</span>
          <span className="topbar-spacer" />

          {/* The palette answers a keyboard shortcut; this is how anyone who
              does not already know that finds out it exists. */}
          <button
            className="palette-trigger"
            onClick={() =>
              window.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }),
              )
            }
            aria-label="Open the command palette"
          >
            <Icon name="search" size={16} />
            <span className="palette-trigger-text">Search or jump to…</span>
            <kbd className="kbd">Ctrl K</kbd>
          </button>

          <SaveState state={saveState} />

          <button
            className="btn btn-icon btn-ghost"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
          </button>
        </header>

        <main className="page">{children}</main>
      </div>

      <AssistantDock />
      <CommandPalette />
    </div>
  );
}

/** "Saving", "Saved" or "Not saved" - announced politely to screen readers. */
function SaveState({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  return (
    <span className="save-state" role="status" aria-live="polite">
      {state === 'saving' && (
        <>
          <span className="spinner" aria-hidden="true" /> Saving
        </>
      )}
      {state === 'saved' && (
        <span className="row gap-1 text-positive">
          <Icon name="check" size={12} /> Saved
        </span>
      )}
      {state === 'error' && (
        <span
          className="row gap-1 text-negative"
          title="Your changes are safe on this device but could not be saved to the server"
        >
          <Icon name="alertCircle" size={12} /> Not saved
        </span>
      )}
    </span>
  );
}
