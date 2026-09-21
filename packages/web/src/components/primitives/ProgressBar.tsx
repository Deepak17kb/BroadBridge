/**
 * A rounded progress bar. It grows in on first paint and eases to a new value
 * (both in the stylesheet), and states its value to assistive technology.
 * Spans rather than divs, so it can sit inside a button or a label.
 */
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
    <span
      className="bar"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? 'Progress'}
    >
      <span className={`bar-fill ${resolved}`} style={{ width: `${pct}%` }} />
    </span>
  );
}
