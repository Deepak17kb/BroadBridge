/**
 * The icon set: one stroke style (1.75, round caps), drawn on a 24px grid and
 * rendered at 16px or 18px. Replaces the text glyphs (✓ ⚠ ℹ ▲ ▼ ✕) the UI used,
 * which rendered differently on every platform and could not be coloured or
 * sized consistently.
 */

const PATHS = {
  check: ['M20 6 9 17l-5-5'],
  alert: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z', 'M12 9v4', 'M12 17h.01'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 16v-4', 'M12 8h.01'],
  alertCircle: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 8v4', 'M12 16h.01'],
  exclamation: ['M12 6v8', 'M12 18h.01'],
  arrowUp: ['M12 19V5', 'm5 12 7-7 7 7'],
  arrowDown: ['M12 5v14', 'm19 12-7 7-7-7'],
  arrowRight: ['M5 12h14', 'm12 5 7 7-7 7'],
  chevronDown: ['m6 9 6 6 6-6'],
  chevronRight: ['m9 6 6 6-6 6'],
  close: ['M18 6 6 18', 'm6 6 12 12'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  plus: ['M12 5v14', 'M5 12h14'],
  sun: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M12 2v2', 'M12 20v2', 'm4.9 4.9 1.4 1.4', 'm17.7 17.7 1.4 1.4', 'M2 12h2', 'M20 12h2', 'm6.3 17.7-1.4 1.4', 'm19.1 4.9-1.4 1.4'],
  moon: ['M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7Z'],
  trend: ['m3 17 6-7 4 4 8-9'],
  dashboard: ['M4 4h6v7H4z', 'M14 4h6v4h-6z', 'M14 12h6v8h-6z', 'M4 15h6v5H4z'],
  actions: ['M13 2 4 14h7l-1 8 9-12h-7l1-8Z'],
  goals: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M12 12h.01'],
  scenarios: ['m3 17 6-6 4 4 8-8', 'M21 7h-5', 'M21 7v5'],
  portfolio: ['M3 3v18h18', 'M7 15v3', 'M12 9v9', 'M17 5v13'],
  assistant: ['M20 15a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z'],
  sparkle: [
    'M12 3.2 13.9 8a3 3 0 0 0 1.7 1.7l4.8 1.9-4.8 1.9A3 3 0 0 0 13.9 15l-1.9 4.8-1.9-4.8a3 3 0 0 0-1.7-1.7L3.6 11.6l4.8-1.9A3 3 0 0 0 10.1 8Z',
    'M18.5 3v3.4',
    'M20.2 4.7h-3.4',
  ],
  expand: ['M14 4h6v6', 'M10 20H4v-6', 'm20 4-7.5 7.5', 'M4 20l7.5-7.5'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'm21 21-4.3-4.3'],
  send: ['m21 3-8 18-3-8-8-3Z', 'M21 3 10 13'],
  assumptions: ['m12 3 9 4.5-9 4.5-9-4.5L12 3Z', 'm3 16.5 9 4.5 9-4.5', 'm3 12 9 4.5 9-4.5'],
  profile: ['M12 13a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z', 'M4 21a8 8 0 0 1 16 0'],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size,
  label,
  className = '',
}: {
  name: IconName;
  /** 16 by default; 18 for navigation and the top bar. */
  size?: 12 | 16 | 18 | 20 | 22 | 24;
  /** An accessible name. Without one the icon is decorative and hidden. */
  label?: string;
  className?: string;
}) {
  return (
    <svg
      className={`icon ${className}`.trim()}
      style={size ? { ['--icon-size' as string]: `${size}px` } : undefined}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
