import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

type Tone = 'info' | 'warning' | 'negative' | 'positive';

const ICON: Record<Tone, IconName> = {
  info: 'info',
  warning: 'alert',
  negative: 'alertCircle',
  positive: 'check',
};

/** A tinted note inside a card: context, a caution, a problem or a win. */
export function Callout({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div className={`callout callout-${tone}`}>
      <Icon name={ICON[tone]} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
