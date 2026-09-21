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

/** A short status label. Colour is never its only signal - the text carries it. */
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: BadgeTone }) {
  return <span className={`badge ${TONE_CLASS[tone]}`.trim()}>{children}</span>;
}
