import type { ReactNode } from 'react';

/**
 * The card: glass surface, a header with title, subtitle and actions, and a
 * body that spaces its blocks on the spacing scale. In a grid it takes the
 * height of its row, so a row of cards shares one baseline; a card that must
 * size to its own content opts out with `self-start` (see the stylesheet).
 */
export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
  flush = false,
  variant = 'default',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** No padding - for content that runs to the card's edges. */
  flush?: boolean;
  /** `primary` gives the page's focal card more presence than its neighbours. */
  variant?: 'default' | 'primary';
}) {
  const classes = ['card', flush && 'card-flush', variant === 'primary' && 'card-primary', className]
    .filter(Boolean)
    .join(' ');
  return (
    <section className={classes}>
      {(title || actions) && <CardHeader title={title} subtitle={subtitle} actions={actions} />}
      <div className="card-body">{children}</div>
    </section>
  );
}

/** A titled part of a card, one heading level below the card's own title. */
export function CardSection({
  title,
  subtitle,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="card-title">{title}</h3>
      {subtitle && <p className="card-sub">{subtitle}</p>}
      <div className="card-section-body">{children}</div>
    </section>
  );
}

/** Title block and actions. The actions drop under the title when space runs out. */
export function CardHeader({
  title,
  subtitle,
  actions,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="card-head">
      <div className="card-heading">
        {title && <h2 className="card-title">{title}</h2>}
        {subtitle && <div className="card-sub">{subtitle}</div>}
      </div>
      {actions && <div className="card-actions">{actions}</div>}
    </header>
  );
}
