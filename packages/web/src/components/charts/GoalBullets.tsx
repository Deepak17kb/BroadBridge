import { formatCompact, fundedPercent, type Currency, type GoalProjection } from '@wealth/shared';
import { fundedAxis } from './Charts';

/**
 * Goals as bullet graphs, one compact row each.
 *
 * This replaced a bubble plot of the same data. The plot encoded more - time
 * on one axis, funding on the other, money as area - but three goals in a
 * two-dimensional plane left most of a 450px panel empty to place three
 * points, and reading a value off it meant tracing to two axes. Stacked rows
 * carry the same four numbers in a sixth of the height and put every figure
 * in a column you can scan straight down.
 *
 * Each row is a bullet graph in Few's sense: banded context behind, the
 * measure over it, and a target marker to read it against. Urgency survives
 * the change as the sort order and the leading column, so the goal that lands
 * first is still the one the eye reaches first.
 */
export function GoalBullets({
  projections,
  currency,
}: {
  projections: GoalProjection[];
  currency: Currency;
}) {
  if (projections.length === 0) return null;

  const rows = projections
    .map((p) => ({
      id: p.goalId,
      name: p.goalName,
      years: p.yearsToGoal,
      funded: fundedPercent(p),
      target: p.inflatedTarget,
      monthlyGap: p.monthlyGap,
      onTrack: p.onTrack,
    }))
    // Soonest first: the goal you have least time to fix leads the list.
    .sort((a, b) => a.years - b.years);

  // One scale for every row, so bar lengths are comparable down the column.
  const { top } = fundedAxis(Math.max(0, ...rows.map((r) => r.funded)));
  const pct = (v: number) => `${(Math.max(0, Math.min(top, v)) / top) * 100}%`;

  return (
    <div className="bullets-chart">
      {rows.map((r) => (
        <div className="bullet-row" key={r.id} data-spot={r.onTrack ? 'var(--positive)' : 'var(--negative)'}>
          <div className="bullet-label">
            <span className="bullet-name truncate">{r.name}</span>
            <span className="bullet-when">
              in {r.years.toFixed(1)}y · {formatCompact(r.target, currency)}
            </span>
          </div>

          <div
            className="bullet-track"
            role="meter"
            aria-valuenow={Math.round(r.funded)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${r.name}, ${Math.round(r.funded)} percent funded, needed in ${r.years.toFixed(1)} years`}
          >
            {/* Banded context: behind, unlabelled, there to be read against. */}
            <span className="bullet-band" style={{ width: pct(50) }} />
            <span className="bullet-band bullet-band-mid" style={{ width: pct(80) }} />
            <span
              className={`bullet-fill ${r.onTrack ? 'is-on-track' : 'is-short'}`}
              style={{ width: pct(r.funded) }}
            />
            {/* The comparative measure: fully funded. */}
            <span className="bullet-target" style={{ left: pct(100) }} />
          </div>

          <span className={`bullet-pct num ${r.onTrack ? 'text-positive' : 'text-negative'}`}>
            {Math.round(r.funded)}%
          </span>

          <span className="bullet-note truncate">
            {r.monthlyGap > 0
              ? `${formatCompact(r.monthlyGap, currency)}/mo would close it`
              : 'Fully funded'}
          </span>
        </div>
      ))}

      <div className="legend mt-3">
        <span className="legend-item" data-spot="var(--positive)">
          <span className="dot" style={{ background: 'var(--positive)' }} />
          On track
        </span>
        <span className="legend-item" data-spot="var(--negative)">
          <span className="dot" style={{ background: 'var(--negative)' }} />
          Short
        </span>
        <span className="legend-item">
          <span className="legend-line" style={{ background: 'var(--text)', width: '2px', height: '12px' }} />
          Fully funded
        </span>
      </div>
    </div>
  );
}
