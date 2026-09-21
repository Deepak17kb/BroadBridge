import { useMemo, useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ASSET_CLASSES,
  ASSET_LABELS,
  formatCompact,
  type AllocationWeights,
  type AssetClass,
  type Currency,
  type GoalProjection,
  type MonteCarloResult,
  type PortfolioAnalysis,
  type WellnessScore,
} from '@wealth/shared';

/**
 * The chart layer.
 *
 * Every form here was chosen from the data's job rather than by preference:
 *
 *  - Simulation outcomes are a *magnitude* spread, so the fan uses one hue in
 *    lightness steps. Five categorical colours would imply five unrelated
 *    series when they are really nested confidence bands.
 *  - Allocation is *part-to-whole*, so it is a horizontal stacked bar, not a
 *    donut - a donut cannot be read for the close values that matter here, and
 *    the asset-class names are too long to fit in slices.
 *  - Drift is *polarity* against a target, so it is a diverging bar centred on
 *    zero rather than two bars the reader has to subtract.
 *  - Every chart carries a legend or direct labels plus a table view, so no
 *    value is reachable by colour or hover alone.
 *
 * Series colours come from CSS custom properties, which is what lets one theme
 * switch restyle every chart with no JavaScript involved.
 */

const SERIES_VARS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
] as const;

/** Asset classes take fixed slots, so a class keeps its colour when others drop out. */
export const ASSET_COLOUR: Record<AssetClass, string> = {
  equity_domestic: SERIES_VARS[0],
  equity_international: SERIES_VARS[1],
  debt: SERIES_VARS[2],
  gold: SERIES_VARS[3],
  reit: SERIES_VARS[4],
  cash: SERIES_VARS[5],
};

const AXIS = {
  stroke: 'var(--text-subtle)',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
} as const;

function Tip({ label, rows }: { label: string; rows: { name: string; value: string; colour?: string }[] }) {
  return (
    <div className="tooltip">
      <div className="tooltip-label">{label}</div>
      {rows.map((r) => (
        <div className="tooltip-row" key={r.name}>
          <span className="row" style={{ gap: 6 }}>
            {r.colour && <span className="dot" style={{ background: r.colour }} />}
            <span className="text-muted">{r.name}</span>
          </span>
          <span className="num strong">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Monte Carlo fan                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Nested confidence bands over time.
 *
 * Drawn as stacked areas because that is the only honest way to get a band
 * between two series in Recharts: a transparent base up to the lower bound,
 * then the visible band on top of it. The alternative - two overlapping opaque
 * areas - would leave the reader unable to tell which edge is which.
 */
export function MonteCarloFan({
  result,
  currency,
  height = 260,
}: {
  result: MonteCarloResult;
  currency: Currency;
  height?: number;
}) {
  const data = useMemo(
    () =>
      result.bands.map((b) => ({
        year: b.year,
        base10: b.p10,
        band10to25: b.p25 - b.p10,
        band25to75: b.p75 - b.p25,
        band75to90: b.p90 - b.p75,
        p50: b.p50,
        p10: b.p10,
        p25: b.p25,
        p75: b.p75,
        p90: b.p90,
      })),
    [result.bands],
  );

  return (
    <div>
      <div className="chart-frame" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 10, left: 4, bottom: 2 }}>
            {/* Solid hairline grid - a dashed grid reads as a threshold line. */}
            <CartesianGrid stroke="var(--grid)" strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey="year"
              tick={AXIS}
              tickLine={false}
              axisLine={{ stroke: 'var(--grid)' }}
              label={{
                value: 'Years from now',
                position: 'insideBottom',
                offset: -2,
                fill: 'var(--text-subtle)',
                fontSize: 10,
              }}
            />
            <YAxis
              tick={AXIS}
              tickLine={false}
              axisLine={false}
              width={58}
              tickFormatter={(v: number) => formatCompact(v, currency)}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0]?.payload as (typeof data)[number] | undefined;
                if (!d) return null;
                return (
                  <Tip
                    label={`Year ${label}`}
                    rows={[
                      { name: 'Best case (90th)', value: formatCompact(d.p90, currency), colour: 'var(--seq-300)' },
                      { name: 'Upper quartile', value: formatCompact(d.p75, currency), colour: 'var(--seq-500)' },
                      { name: 'Median', value: formatCompact(d.p50, currency), colour: 'var(--seq-700)' },
                      { name: 'Lower quartile', value: formatCompact(d.p25, currency), colour: 'var(--seq-500)' },
                      { name: 'Worst case (10th)', value: formatCompact(d.p10, currency), colour: 'var(--seq-300)' },
                    ]}
                  />
                );
              }}
            />
            {/* Invisible plinth so the bands above it start at p10. */}
            <Area
              type="monotone"
              dataKey="base10"
              stackId="fan"
              stroke="none"
              fill="transparent"
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="band10to25"
              stackId="fan"
              stroke="none"
              fill="var(--seq-100)"
              fillOpacity={0.55}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="band25to75"
              stackId="fan"
              stroke="none"
              fill="var(--seq-300)"
              fillOpacity={0.6}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="band75to90"
              stackId="fan"
              stroke="none"
              fill="var(--seq-100)"
              fillOpacity={0.55}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="p50"
              stroke="var(--seq-700)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            {result.target > 0 && (
              <ReferenceLine
                y={result.target}
                stroke="var(--warning)"
                strokeWidth={1.5}
                label={{
                  value: `Target ${formatCompact(result.target, currency)}`,
                  position: 'insideTopRight',
                  fill: 'var(--warning)',
                  fontSize: 10,
                  fontWeight: 700,
                }}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="legend" style={{ marginTop: 8 }}>
        <span className="legend-item">
          <span className="dot" style={{ background: 'var(--seq-700)' }} /> Median path
        </span>
        <span className="legend-item">
          <span className="dot" style={{ background: 'var(--seq-300)' }} /> Middle 50% of outcomes
        </span>
        <span className="legend-item">
          <span className="dot" style={{ background: 'var(--seq-100)' }} /> 10th-90th percentile
        </span>
        <span className="legend-item">
          <span className="dot" style={{ background: 'var(--warning)' }} /> Target
        </span>
      </div>
    </div>
  );
}

/** Terminal-value distribution. Sequential, with the target as a reference line. */
export function OutcomeHistogram({
  result,
  currency,
  height = 170,
}: {
  result: MonteCarloResult;
  currency: Currency;
  height?: number;
}) {
  const data = result.histogram.map((b) => ({
    label: formatCompact(b.bucketStart, currency),
    start: b.bucketStart,
    end: b.bucketEnd,
    count: b.count,
    // Buckets below the target are the failure region - a polarity, so it gets
    // the status colour rather than another series hue.
    short: b.bucketEnd < result.target,
  }));

  return (
    <div>
      <div className="chart-frame" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 10, left: 0, bottom: 0 }} barCategoryGap={2}>
            <CartesianGrid stroke="var(--grid)" strokeDasharray="0" vertical={false} />
            <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: 'var(--grid)' }} interval={3} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={34} />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0]?.payload as (typeof data)[number] | undefined;
                if (!d) return null;
                return (
                  <Tip
                    label={`${formatCompact(d.start, currency)} - ${formatCompact(d.end, currency)}`}
                    rows={[
                      { name: 'Simulated paths', value: String(d.count) },
                      { name: 'Share of runs', value: `${((d.count / result.paths) * 100).toFixed(1)}%` },
                      { name: 'Versus target', value: d.short ? 'Falls short' : 'Meets target' },
                    ]}
                  />
                );
              }}
            />
            <Bar dataKey="count" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.short ? 'var(--negative)' : 'var(--seq-500)'} fillOpacity={0.85} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="legend" style={{ marginTop: 6 }}>
        <span className="legend-item">
          <span className="dot" style={{ background: 'var(--seq-500)' }} /> Meets the target
        </span>
        <span className="legend-item">
          <span className="dot" style={{ background: 'var(--negative)' }} /> Falls short
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Allocation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Part-to-whole composition as a horizontal stacked bar.
 *
 * Segments are separated by a 2px surface gap rather than a stroke, and only
 * segments wide enough to hold text are labelled in place - a clipped label is
 * worse than no label, and the table below carries every value regardless.
 */
export function AllocationBar({
  weights,
  label,
  total,
  currency = 'INR',
}: {
  weights: AllocationWeights;
  label: string;
  /** When supplied with `currency`, the hover readout shows the amount too. */
  total?: number;
  currency?: Currency;
}) {
  const [hovered, setHovered] = useState<AssetClass | null>(null);
  const present = ASSET_CLASSES.filter((ac) => (weights[ac] ?? 0) > 0.001);

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 6 }}>
        <span className="text-sm strong">{label}</span>
        {hovered && (
          <span className="text-xs text-muted">
            {ASSET_LABELS[hovered]} · {((weights[hovered] ?? 0) * 100).toFixed(1)}%
            {total && currency ? ` · ${formatCompact((weights[hovered] ?? 0) * total, currency)}` : ''}
          </span>
        )}
      </div>
      <div className="composition" role="img" aria-label={`${label}: ${present.map((ac) => `${ASSET_LABELS[ac]} ${((weights[ac] ?? 0) * 100).toFixed(0)}%`).join(', ')}`}>
        {present.map((ac) => {
          const pct = (weights[ac] ?? 0) * 100;
          return (
            <div
              key={ac}
              className="composition-segment"
              style={{
                flex: `0 0 calc(${pct}% - 2px)`,
                background: ASSET_COLOUR[ac],
                opacity: hovered && hovered !== ac ? 0.45 : 1,
              }}
              onMouseEnter={() => setHovered(ac)}
              onMouseLeave={() => setHovered(null)}
            >
              {/* ~7% is the narrowest segment that fits "12%" with padding. */}
              {pct >= 7 && <span className="composition-label">{pct.toFixed(0)}%</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AllocationLegend({ weights }: { weights: AllocationWeights }) {
  return (
    <div className="legend" style={{ marginTop: 10 }}>
      {ASSET_CLASSES.filter((ac) => (weights[ac] ?? 0) > 0.001).map((ac) => (
        <span className="legend-item" key={ac}>
          <span className="dot" style={{ background: ASSET_COLOUR[ac] }} />
          {ASSET_LABELS[ac]}
        </span>
      ))}
    </div>
  );
}

/**
 * Drift from target, as a diverging bar centred on zero.
 *
 * The reader's question is "which way and how far off am I", which is polarity -
 * so over- and under-weight get opposite directions from a shared midpoint
 * instead of being two numbers to subtract.
 */
export function DriftChart({
  portfolio,
  currency,
}: {
  portfolio: PortfolioAnalysis;
  currency: Currency;
}) {
  const rows = portfolio.drift.filter((d) => d.current > 0.001 || d.target > 0.001);
  // A shared scale across rows, so bar lengths are comparable between classes.
  const maxAbs = Math.max(0.05, ...rows.map((d) => Math.abs(d.deltaPct)));

  return (
    <div className="stack-sm">
      {rows.map((d) => {
        const ratio = Math.min(1, Math.abs(d.deltaPct) / maxAbs);
        const over = d.deltaPct > 0;
        const width = (ratio * 50).toFixed(1);
        return (
          <div className="drift-row" key={d.assetClass}>
            <span className="text-sm text-muted">{ASSET_LABELS[d.assetClass]}</span>
            <div
              className="drift-track"
              title={`${(d.current * 100).toFixed(1)}% held vs ${(d.target * 100).toFixed(1)}% target — ${
                d.tradeAmount >= 0 ? 'buy' : 'sell'
              } ${formatCompact(Math.abs(d.tradeAmount), currency)} to correct`}
            >
              <span className="drift-zero" />
              <span
                className="drift-bar"
                style={{
                  background: over ? 'var(--warning)' : 'var(--info)',
                  width: `${width}%`,
                  left: over ? '50%' : `calc(50% - ${width}%)`,
                }}
              />
            </div>
            <span className={`text-xs num ${over ? 'text-warning' : ''}`} style={{ textAlign: 'right' }}>
              {over ? '+' : ''}
              {(d.deltaPct * 100).toFixed(1)} pt
            </span>
          </div>
        );
      })}
      <div className="legend" style={{ marginTop: 4 }}>
        <span className="legend-item">
          <span className="dot" style={{ background: 'var(--info)' }} /> Below target
        </span>
        <span className="legend-item">
          <span className="dot" style={{ background: 'var(--warning)' }} /> Above target
        </span>
        <span className="text-xs text-subtle">
          {portfolio.totalDriftPct}% of the portfolio needs to move · trades shown below
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Goals and scores                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Projected corpus against the inflated target, per goal.
 *
 * Two measures on one axis, both in currency, so a single scale is correct -
 * a second y-axis here would be the classic dual-axis mistake.
 */
export function GoalFundingChart({
  projections,
  currency,
  height = 250,
}: {
  projections: GoalProjection[];
  currency: Currency;
  height?: number;
}) {
  const data = projections.map((p) => ({
    name: p.goalName.length > 17 ? `${p.goalName.slice(0, 16)}…` : p.goalName,
    fullName: p.goalName,
    projected: p.projectedCorpus,
    target: p.inflatedTarget,
    onTrack: p.onTrack,
    funded: p.fundedRatio,
    years: p.yearsToGoal,
  }));

  return (
    <div>
      <div className="chart-frame" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 6, right: 12, left: 4, bottom: 4 }} barGap={2}>
            <CartesianGrid stroke="var(--grid)" strokeDasharray="0" vertical={false} />
            <XAxis dataKey="name" tick={{ ...AXIS, fontFamily: 'var(--font)' }} tickLine={false} axisLine={{ stroke: 'var(--grid)' }} />
            <YAxis
              tick={AXIS}
              tickLine={false}
              axisLine={false}
              width={58}
              tickFormatter={(v: number) => formatCompact(v, currency)}
            />
            <Tooltip
              // No hover highlight at all - only the tooltip card. Recharts
              // otherwise draws a solid #ccc block behind the hovered category.
              cursor={false}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0]?.payload as (typeof data)[number] | undefined;
                if (!d) return null;
                return (
                  <Tip
                    label={d.fullName}
                    rows={[
                      { name: 'Needed at goal date', value: formatCompact(d.target, currency), colour: 'var(--text-subtle)' },
                      { name: 'Projected', value: formatCompact(d.projected, currency), colour: d.onTrack ? 'var(--positive)' : 'var(--negative)' },
                      { name: 'Funded', value: `${(d.funded * 100).toFixed(0)}%` },
                      { name: 'Years away', value: d.years.toFixed(1) },
                    ]}
                  />
                );
              }}
            />
            {/* The target is context, so it sits in a recessive grey; the
                projection is the subject and carries the status colour. */}
            <Bar dataKey="target" fill="var(--border-strong)" radius={[4, 4, 0, 0]} isAnimationActive={false} name="Needed" />
            <Bar dataKey="projected" radius={[4, 4, 0, 0]} isAnimationActive={false} name="Projected">
              {data.map((d, i) => (
                <Cell key={i} fill={d.onTrack ? 'var(--positive)' : 'var(--negative)'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="legend" style={{ marginTop: 8 }}>
        <span className="legend-item">
          <span className="dot" style={{ background: 'var(--border-strong)' }} /> Needed at the goal date
        </span>
        <span className="legend-item">
          <span className="dot" style={{ background: 'var(--positive)' }} /> Projected - on track
        </span>
        <span className="legend-item">
          <span className="dot" style={{ background: 'var(--negative)' }} /> Projected - short
        </span>
      </div>
    </div>
  );
}

/**
 * Wellness pillars as meters.
 *
 * Each pillar is one ratio against a fixed limit, which the form heuristic
 * answers with a meter rather than a chart - five bars in five colours would
 * imply the pillars are a series to compare, when each is its own 0-100 scale.
 */
export function PillarMeters({ wellness }: { wellness: WellnessScore }) {
  return (
    <div className="stack-sm">
      {wellness.pillars.map((p) => {
        const tone = p.score >= 80 ? 'positive' : p.score >= 55 ? 'warning' : 'negative';
        return (
          <div key={p.name}>
            <div className="row-between" style={{ marginBottom: 4 }}>
              <span className="text-sm">
                {p.name}{' '}
                <span className="text-xs text-subtle">({(p.weight * 100).toFixed(0)}% of score)</span>
              </span>
              {/* An unscored pillar shows a dash, not a zero - "0/100" reads as a
                  bad result when the truth is that nothing was measured. */}
              {p.scored ? (
                <span
                  className={`text-sm num strong text-${tone === 'positive' ? 'positive' : tone === 'warning' ? 'warning' : 'negative'}`}
                >
                  {p.score}
                </span>
              ) : (
                <span className="text-sm text-subtle">not scored</span>
              )}
            </div>
            <div
              className="bar"
              role="meter"
              aria-valuenow={p.scored ? p.score : 0}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={p.scored ? `${p.name} score` : `${p.name} not scored yet`}
            >
              {p.scored && (
                <div
                  className={`bar-fill ${tone}`}
                  style={{ width: `${Math.max(0, Math.min(100, p.score))}%` }}
                />
              )}
            </div>
            <div className="text-xs text-subtle" style={{ marginTop: 3 }}>
              {p.summary}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Expense composition. Horizontal because category names are long. */
export function ExpenseBars({
  breakdown,
  currency,
}: {
  breakdown: { category: string; amount: number; sharePct: number }[];
  currency: Currency;
}) {
  const max = Math.max(1, ...breakdown.map((b) => b.amount));
  return (
    <div className="stack-sm">
      {breakdown.map((b, i) => (
        <div className="composition-row" key={b.category}>
          <span className="text-sm text-muted" title={b.category} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {b.category}
          </span>
          <div className="row" style={{ gap: 9 }}>
            <div className="bar" style={{ flex: 1, height: 9 }}>
              {/* One hue: this is magnitude, not identity. The largest category
                  is emphasised so the eye lands on what matters. */}
              <div
                className="bar-fill"
                style={{
                  width: `${(b.amount / max) * 100}%`,
                  background: i === 0 ? 'var(--series-1)' : 'var(--seq-300)',
                }}
              />
            </div>
            <span className="text-sm num" style={{ minWidth: 72, textAlign: 'right' }}>
              {formatCompact(b.amount, currency)}
            </span>
            <span className="text-xs text-subtle num" style={{ minWidth: 40, textAlign: 'right' }}>
              {(b.sharePct * 100).toFixed(0)}%
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Scenario comparison. Horizontal bars against a baseline reference line, so
 * "better or worse than today's plan" is read from the line, not from arithmetic.
 */
export function ScenarioComparison({
  rows,
  baseline,
  currency,
  height = 230,
}: {
  rows: { label: string; value: number; delta: number }[];
  baseline: number;
  currency: Currency;
  height?: number;
}) {
  const data = rows.map((r) => ({
    ...r,
    name: r.label.length > 26 ? `${r.label.slice(0, 25)}…` : r.label,
  }));

  return (
    <div>
      <div className="chart-frame" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 4, right: 58, left: 4, bottom: 4 }}>
            <CartesianGrid stroke="var(--grid)" strokeDasharray="0" horizontal={false} />
            <XAxis
              type="number"
              tick={AXIS}
              tickLine={false}
              axisLine={{ stroke: 'var(--grid)' }}
              tickFormatter={(v: number) => formatCompact(v, currency)}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ ...AXIS, fontFamily: 'var(--font)', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={168}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0]?.payload as (typeof data)[number] | undefined;
                if (!d) return null;
                return (
                  <Tip
                    label={d.label}
                    rows={[
                      { name: 'Retirement corpus', value: formatCompact(d.value, currency) },
                      {
                        name: 'Versus current plan',
                        value: `${d.delta >= 0 ? '+' : '-'}${formatCompact(Math.abs(d.delta), currency)}`,
                      },
                    ]}
                  />
                );
              }}
            />
            <ReferenceLine
              x={baseline}
              stroke="var(--text-subtle)"
              strokeWidth={1.5}
              label={{
                value: 'Today',
                position: 'top',
                fill: 'var(--text-subtle)',
                fontSize: 10,
                fontWeight: 700,
              }}
            />
            <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={false} barSize={18}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.delta >= 0 ? 'var(--positive)' : 'var(--negative)'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="legend" style={{ marginTop: 6 }}>
        <span className="legend-item">
          <span className="dot" style={{ background: 'var(--positive)' }} /> Better than today's plan
        </span>
        <span className="legend-item">
          <span className="dot" style={{ background: 'var(--negative)' }} /> Worse
        </span>
        <span className="legend-item">
          <span style={{ width: 12, height: 2, background: 'var(--text-subtle)' }} /> Current plan
        </span>
      </div>
    </div>
  );
}

/**
 * Table view toggle.
 *
 * Present on every chart that carries a value a reader might need exactly. It
 * is also what satisfies the light-mode contrast relief rule: three of the
 * categorical steps sit below 3:1 on a white surface, which is permitted only
 * when the values are readable another way.
 */
export function TableToggle({
  children,
  label = 'View as table',
}: {
  children: ReactNode;
  label?: string;
}) {
  return (
    <details className="disclosure" style={{ marginTop: 12 }}>
      <summary>{label}</summary>
      <div className="disclosure-body table-wrap">{children}</div>
    </details>
  );
}
