import type { ReactNode } from 'react';
import { formatCompact, type Currency } from '@wealth/shared';
import { Icon } from './Icon';

type Tone = 'neutral' | 'positive' | 'negative' | 'warning';

const TONE_CLASS: Record<Tone, string> = {
  neutral: '',
  positive: 'text-positive',
  negative: 'text-negative',
  warning: 'text-warning',
};

/** A labelled figure with an optional change and footnote. */
export function Stat({
  label,
  value,
  meta,
  delta,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  meta?: ReactNode;
  delta?: { value: number; currency?: Currency; suffix?: string };
  tone?: Tone;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${TONE_CLASS[tone]}`.trim()}>{value}</div>
      {delta && <Delta {...delta} />}
      {meta && <div className="stat-meta">{meta}</div>}
    </div>
  );
}

function Delta({ value, currency, suffix = '' }: { value: number; currency?: Currency; suffix?: string }) {
  const direction = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  const magnitude = currency ? formatCompact(Math.abs(value), currency) : Math.abs(value).toFixed(0);
  return (
    <div className={`delta ${direction}`}>
      {direction === 'up' && <Icon name="arrowUp" size={12} />}
      {direction === 'down' && <Icon name="arrowDown" size={12} />}
      <span className="num">
        {direction === 'flat' ? 'No change' : magnitude}
        {direction === 'flat' ? '' : suffix}
      </span>
    </div>
  );
}
