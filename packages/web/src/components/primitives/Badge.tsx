import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'positive' | 'negative' | 'warning' | 'info' | 'accent';

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: '',
  positive: 'badge-positive',
  negative: 'badge-negative',
  warning: 'badge-warning',
  info: 'badge-info',
  accent: 'badge-accent',
};

/** The hue each tone lends the cursor's spotlight while it is over the badge. */
const TONE_SPOT: Record<BadgeTone, string | undefined> = {
  neutral: undefined,
  positive: 'var(--positive)',
  negative: 'var(--negative)',
  warning: 'var(--warning)',
  info: 'var(--info)',
  accent: 'var(--accent)',
};

/** A short status label. Colour is never its only signal - the text carries it. */
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: BadgeTone }) {
  return (
    <span className={`badge ${TONE_CLASS[tone]}`.trim()} data-spot={TONE_SPOT[tone]}>
      {children}
    </span>
  );
}
