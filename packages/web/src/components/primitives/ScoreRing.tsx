const STROKE = 9;

/**
 * The wellness gauge. An SVG ring rather than a chart library - one number,
 * no axes, and it scales crisply at any size.
 */
export function ScoreRing({ score, grade, size = 132 }: { score: number; grade?: string; size?: number }) {
  const radius = size / 2 - STROKE;
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
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-sunken)" strokeWidth={STROKE} />
        <circle
          className="ring-arc"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={colour}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          /* The sweep starts from empty, which is one full circumference of
             dash offset; the stylesheet animates to the value above. */
          style={{ ['--arc-len' as string]: circumference }}
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
