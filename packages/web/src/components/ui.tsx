import type { ReactNode } from 'react';
import { formatCompact, formatCurrency, type Assumption, type Currency } from '@wealth/shared';

/**
 * Shared primitives. Small, unopinionated and typed - the pages compose these
 * rather than re-declaring the same markup with slightly different spacing.
 */

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
  flush = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={`card ${flush ? 'card-flush' : ''} ${className}`.trim()}>
      {(title || actions) && (
        <header className="card-head" style={flush ? { padding: '18px 18px 0', marginBottom: 14 } : undefined}>
          <div>
            {title && <h3 className="card-title">{title}</h3>}
            {subtitle && <div className="card-sub">{subtitle}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

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
  tone?: 'neutral' | 'positive' | 'negative' | 'warning';
}) {
  const toneClass =
    tone === 'positive'
      ? 'text-positive'
      : tone === 'negative'
        ? 'text-negative'
        : tone === 'warning'
          ? 'text-warning'
          : '';
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className={`stat-value num ${toneClass}`}>{value}</div>
      {delta && (
        <div className={`delta ${delta.value > 0 ? 'up' : delta.value < 0 ? 'down' : 'flat'}`}>
          {delta.value > 0 ? '▲' : delta.value < 0 ? '▼' : '—'}{' '}
          <span className="num">
            {delta.currency
              ? formatCompact(Math.abs(delta.value), delta.currency)
              : Math.abs(delta.value).toFixed(0)}
            {delta.suffix ?? ''}
          </span>
        </div>
      )}
      {meta && <div className="stat-meta">{meta}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'positive' | 'negative' | 'warning' | 'info' | 'accent';
}) {
  const map = {
    neutral: '',
    positive: 'badge-positive',
    negative: 'badge-negative',
    warning: 'badge-warning',
    info: 'badge-info',
    accent: 'badge-accent',
  } as const;
  return <span className={`badge ${map[tone]}`.trim()}>{children}</span>;
}

export function ProgressBar({
  value,
  tone,
  label,
}: {
  /** 0-1. Values above 1 are clamped, so an over-funded goal shows as full. */
  value: number;
  tone?: 'positive' | 'warning' | 'negative';
  label?: string;
}) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const resolved = tone ?? (value >= 0.98 ? 'positive' : value >= 0.7 ? 'warning' : 'negative');
  return (
    <div>
      <div
        className="bar"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? 'Progress'}
      >
        <div className={`bar-fill ${resolved}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/**
 * The wellness gauge. An SVG ring rather than a chart library - one number,
 * no axes, and it scales crisply at any size.
 */
export function ScoreRing({
  score,
  grade,
  size = 132,
}: {
  score: number;
  grade?: string;
  size?: number;
}) {
  const radius = size / 2 - 9;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, score));
  const offset = circumference * (1 - clamped / 100);
  const colour =
    clamped >= 80
      ? 'var(--positive)'
      : clamped >= 65
        ? 'var(--info)'
        : clamped >= 45
          ? 'var(--warning)'
          : 'var(--negative)';

  return (
    <div className="ring" style={{ ['--ring-size' as string]: `${size}px` }}>
      <svg width={size} height={size} aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--surface-sunken)"
          strokeWidth="9"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={colour}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(0.22, 1, 0.36, 1)' }}
        />
      </svg>
      <div className="ring-center">
        <div>
          <div className="ring-score num" style={{ color: colour }}>
            {Math.round(clamped)}
          </div>
          {grade && <div className="ring-grade">Grade {grade}</div>}
        </div>
      </div>
      <span className="sr-only">
        Financial wellness score {Math.round(clamped)} out of 100{grade ? `, grade ${grade}` : ''}
      </span>
    </div>
  );
}

/**
 * The assumptions ledger.
 *
 * Every projection in the platform renders this. Showing where each number came
 * from - the user, a house assumption, a model default, or derived - is what
 * separates an explainable recommendation from a confident-looking guess.
 */
export function AssumptionList({
  assumptions,
  title = 'Assumptions behind this',
  open = false,
}: {
  assumptions: Assumption[];
  title?: string;
  open?: boolean;
}) {
  if (assumptions.length === 0) return null;
  const labels: Record<Assumption['source'], string> = {
    user_input: 'your input',
    market_assumption: 'house view',
    model_default: 'model',
    derived: 'derived',
  };
  return (
    <details className="disclosure" open={open}>
      <summary>
        {title} ({assumptions.length})
      </summary>
      <div className="disclosure-body">
        <div className="assumptions">
          {assumptions.map((a, i) => (
            <div className="assumption" key={`${a.label}-${i}`}>
              <div className="assumption-label">{a.label}</div>
              <div className="assumption-value">
                {a.value}
                <span className={`source-tag source-${a.source}`}>{labels[a.source]}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

export function Callout({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warning' | 'negative' | 'positive';
  children: ReactNode;
}) {
  const icon = { info: 'ℹ', warning: '⚠', negative: '⚠', positive: '✓' }[tone];
  return (
    <div className={`callout callout-${tone}`}>
      <span aria-hidden="true" style={{ flexShrink: 0, fontWeight: 700 }}>
        {icon}
      </span>
      <div>{children}</div>
    </div>
  );
}

export function Empty({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="strong" style={{ fontSize: '1.02rem', color: 'var(--text)' }}>
        {title}
      </div>
      <p style={{ maxWidth: '46ch', margin: '7px auto 16px' }}>{message}</p>
      {action}
    </div>
  );
}

/** Labelled number input that keeps its own text state so partial edits work. */
export function MoneyInput({
  label,
  value,
  onChange,
  currency,
  hint,
  min = 0,
  max,
  step = 1000,
  id,
}: {
  label?: string;
  value: number;
  onChange: (next: number) => void;
  currency: Currency;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  id?: string;
}) {
  const symbol = currency === 'INR' ? '₹' : '$';
  return (
    <div className="field">
      {label && <label htmlFor={id}>{label}</label>}
      <div className="input-prefix">
        <span aria-hidden="true">{symbol}</span>
        <input
          id={id}
          className="input num"
          type="number"
          inputMode="decimal"
          value={Number.isFinite(value) ? value : 0}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const next = Number.parseFloat(e.target.value);
            onChange(Number.isFinite(next) ? next : 0);
          }}
        />
      </div>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

/** Slider with a live readout. The readout is the point - a bare slider hides its value. */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  format: (value: number) => string;
  hint?: string;
}) {
  const id = `slider-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="slider-row">
        <input
          id={id}
          className="slider"
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number.parseFloat(e.target.value))}
          aria-valuetext={format(value)}
        />
        <div className="slider-value">{format(value)}</div>
      </div>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function Money({
  value,
  currency,
  compact = true,
  signed = false,
}: {
  value: number;
  currency: Currency;
  compact?: boolean;
  signed?: boolean;
}) {
  const text = compact
    ? formatCompact(Math.abs(value), currency)
    : formatCurrency(Math.abs(value), currency);
  const sign = signed && value > 0 ? '+' : value < 0 ? '-' : '';
  return (
    <span className="num">
      {sign}
      {text}
    </span>
  );
}

/** Small header used above each chart, carrying the "what am I looking at". */
export function ChartHeading({ title, note }: { title: string; note?: string }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="card-title">{title}</div>
      {note && <div className="card-sub">{note}</div>}
    </div>
  );
}
