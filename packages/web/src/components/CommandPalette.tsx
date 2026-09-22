import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useProfile } from '../state/ProfileContext';
import { Icon, type IconName } from './ui';

/**
 * Ctrl/Cmd-K: jump anywhere, or hand a question straight to the assistant.
 *
 * Everything here is reachable by mouse elsewhere - the palette exists so the
 * platform can be driven without leaving the keyboard, which is how anyone
 * demonstrating it or using it daily actually moves through it.
 *
 * Matching is a subsequence test rather than a substring one, so "sclb" finds
 * "Scenario Lab" - the way a fuzzy finder behaves is the reason people reach
 * for one instead of the navigation.
 */

interface Command {
  id: string;
  label: string;
  hint: string;
  icon: IconName;
  group: 'Go to' | 'Do';
  run: () => void;
}

/** True when every character of `query` appears in `text`, in order. */
function subsequence(text: string, query: string): boolean {
  if (!query) return true;
  let i = 0;
  for (const ch of text) {
    if (ch === query[i]) i += 1;
    if (i === query.length) return true;
  }
  return false;
}

const PAGES: { to: string; label: string; hint: string; icon: IconName }[] = [
  { to: '/dashboard', label: 'Dashboard', hint: 'Score, balance sheet, goals', icon: 'dashboard' },
  { to: '/actions', label: 'Next Best Actions', hint: 'Ranked by impact for effort', icon: 'actions' },
  { to: '/goals', label: 'Goals', hint: 'Targets and what funds them', icon: 'goals' },
  { to: '/scenarios', label: 'Scenario Lab', hint: 'Test a what-if against the model', icon: 'scenarios' },
  { to: '/portfolio', label: 'Portfolio', hint: 'Holdings, drift and risk ladder', icon: 'portfolio' },
  { to: '/assistant', label: 'AI Assistant', hint: 'Ask, with the reasoning shown', icon: 'assistant' },
  { to: '/assumptions', label: 'Assumptions', hint: 'Every figure the plan rests on', icon: 'assumptions' },
  { to: '/profile', label: 'My Details', hint: 'The inputs behind everything', icon: 'profile' },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const { profile, theme, toggleTheme, reset } = useProfile();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActive(0);
  }, []);

  // The one global binding. Ctrl-K is taken by the browser's address bar on
  // some platforms, so Cmd-K is accepted too and the event is claimed.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const go: Command[] = PAGES.map((p) => ({
      id: p.to,
      label: p.label,
      hint: p.hint,
      icon: p.icon,
      group: 'Go to',
      run: () => navigate(p.to),
    }));

    const act: Command[] = [
      {
        id: 'theme',
        label: theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme',
        hint: 'Changes every screen at once',
        icon: theme === 'dark' ? 'sun' : 'moon',
        group: 'Do',
        run: toggleTheme,
      },
    ];
    if (profile) {
      act.push({
        id: 'reset',
        label: 'Switch profile',
        hint: 'Back to the start screen',
        icon: 'profile',
        group: 'Do',
        run: reset,
      });
    }
    return [...go, ...act];
  }, [navigate, profile, reset, theme, toggleTheme]);

  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () => commands.filter((c) => subsequence(c.label.toLowerCase(), needle)),
    [commands, needle],
  );

  // A question that matches nothing is still worth something: it goes to the
  // assistant rather than the palette shrugging.
  const askQuery = needle && matches.length === 0 ? query.trim() : '';

  const total = matches.length + (askQuery ? 1 : 0);
  const clampedActive = total === 0 ? 0 : Math.min(active, total - 1);

  const runAt = (index: number) => {
    if (askQuery && index === matches.length) {
      navigate('/assistant');
      close();
      return;
    }
    const cmd = matches[index];
    if (!cmd) return;
    cmd.run();
    close();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => (total === 0 ? 0 : (i + 1) % total));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (total === 0 ? 0 : (i - 1 + total) % total));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runAt(clampedActive);
    }
  };

  // Keep the highlighted row in view when the list is longer than the panel.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [clampedActive, needle]);

  if (!open) return null;

  let lastGroup = '';

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-input-row">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            placeholder="Jump to a screen, or ask a question…"
            aria-label="Command or question"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <kbd className="kbd">Esc</kbd>
        </div>

        <div className="palette-list" ref={listRef} role="listbox" aria-label="Results">
          {matches.map((cmd, i) => {
            const header = cmd.group !== lastGroup ? cmd.group : null;
            lastGroup = cmd.group;
            return (
              <div key={cmd.id}>
                {header && <div className="palette-group">{header}</div>}
                <button
                  className="palette-item"
                  role="option"
                  aria-selected={i === clampedActive}
                  data-active={i === clampedActive}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => runAt(i)}
                >
                  <Icon name={cmd.icon} size={18} />
                  <span className="palette-item-text">
                    <span className="palette-item-label">{cmd.label}</span>
                    <span className="palette-item-hint">{cmd.hint}</span>
                  </span>
                  <Icon name="arrowRight" size={16} />
                </button>
              </div>
            );
          })}

          {askQuery && (
            <div>
              <div className="palette-group">Ask</div>
              <button
                className="palette-item"
                role="option"
                aria-selected={clampedActive === matches.length}
                data-active={clampedActive === matches.length}
                onMouseEnter={() => setActive(matches.length)}
                onClick={() => runAt(matches.length)}
              >
                <Icon name="sparkle" size={18} />
                <span className="palette-item-text">
                  <span className="palette-item-label">Ask the assistant</span>
                  <span className="palette-item-hint truncate">“{askQuery}”</span>
                </span>
                <Icon name="arrowRight" size={16} />
              </button>
            </div>
          )}
        </div>

        <div className="palette-foot">
          <span>
            <kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> to move
          </span>
          <span>
            <kbd className="kbd">↵</kbd> to open
          </span>
        </div>
      </div>
    </div>
  );
}
