import { useMemo, useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
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
  type MonteCarloResult,
  type PortfolioAnalysis,
  type WellnessScore,
} from '@wealth/shared';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useChartEntrance } from '../../hooks/useChartEntrance';

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
 *  - Hovering shows the tooltip card and nothing else: no cursor band behind
 *    the category, no highlighted bar. The card is the readout.
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

/**
 * Axis labels: muted, in the figure face. `fill` colours tick text; a `stroke`
 * here outlines every glyph, which is what made the labels look heavy.
 *
 * `width` switches off Recharts' label wrapping. It measures a label in the
 * page's body font rather than this one, so it broke "₹35.00 L" over two
 * lines with room to spare; the axes are sized to their labels instead.
 */
const AXIS = {
  fill: 'var(--text-subtle)',
  fontSize: 11,
  fontFamily: 'var(--font-num)',
  width: 1000,
} as const;

/** Smaller labels on a phone; the axes then thin them to fit. */
const AXIS_NARROW = { ...AXIS, fontSize: 10 } as const;

/** Every tooltip: the card only, and no easing lag behind the pointer. */
const TOOLTIP = { cursor: false, isAnimationActive: false } as const;

function useChartAxis() {
  const narrow = useMediaQuery('(max-width: 479px)');
  return { narrow, tick: narrow ? AXIS_NARROW : AXIS };
}

/**
 * Room for an axis of figures. Tick labels are set in tabular figures, so
 * every digit takes the same width and the widest label can be measured from
 * its length alone - no label wraps ("₹16.16" over "Cr") for want of a few
 * pixels. 0.6em per character is an over-estimate for this face, which is the
 * safe direction to be wrong in.
 */
function axisWidth(labels: string[], fontSize: number): number {
  const longest = Math.max(1, ...labels.map((label) => label.length));
  return Math.ceil(longest * fontSize * 0.6) + 12;
}

/** The glass card a chart shows on hover: a heading, then label and value rows. */
export function ChartTooltip({
  label,
  rows,
}: {
  label: string;
  rows: { name: string; value: string; colour?: string }[];
}) {
  return (
    <div className="tooltip">
      <div className="tooltip-label">{label}</div>
      {rows.map((r) => (
        <div className="tooltip-row" key={r.name}>
          <span className="row gap-2">
            {r.colour && <span className="dot" style={{ background: r.colour }} />}
            <span className="text-muted">{r.name}</span>
          </span>
          <span className="num strong">{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function LegendItem({
  colour,
  line = false,
  children,
}: {
  colour: string;
  /** A short rule instead of a dot, for a reference line. */
  line?: boolean;
  children: ReactNode;
}) {
  return (
    <span className="legend-item" data-spot={colour}>
      <span className={line ? 'legend-line' : 'dot'} style={{ background: colour }} />
      {children}
    </span>
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
  const { narrow, tick } = useChartAxis();
  const entrance = useChartEntrance();
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
  // The top tick is rounded up to a "nice" value, so size for a little above the data.
  const top = Math.max(result.target, ...result.bands.map((b) => b.p90));
  const yWidth = axisWidth(
    [formatCompact(top, currency), formatCompact(top * 1.5, currency)],
    tick.fontSize,
  );

  return (
    <div>
      <div className="chart-frame" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {/* Right margin leaves room for the last year label, centred on the edge. */}
          <AreaChart data={data} margin={{ top: 6, right: 16, left: 4, bottom: 2 }}>
            {/*
             * The bands fade toward the far edge of the fan. Uncertainty widens
             * with time, and a flat fill states every year with equal
             * confidence; the gradient lets the later years read as looser.
             */}
            <defs>
              {/*
               * Held near opaque. These were 0.75 falling to 0.42, which on a
               * near-black ground left the outer band barely separable from
               * the card behind it - the fan read as a smudge. The far edge
               * still fades, because uncertainty does widen with time, but it
               * fades between two visible values rather than into the page.
               */}
              <linearGradient id="fan-outer" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="var(--seq-100)" stopOpacity={1} />
                <stop offset="100%" stopColor="var(--seq-100)" stopOpacity={0.82} />
              </linearGradient>
              <linearGradient id="fan-inner" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="var(--seq-300)" stopOpacity={1} />
                <stop offset="100%" stopColor="var(--seq-300)" stopOpacity={0.88} />
              </linearGradient>
            </defs>
            {/* Solid hairline grid - a dashed grid reads as a threshold line. */}
            <CartesianGrid stroke="var(--grid)" strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey="year"
              tick={tick}
              tickLine={false}
              axisLine={{ stroke: 'var(--grid)' }}
              interval="preserveStartEnd"
              minTickGap={narrow ? 14 : 8}
              label={{
                value: 'Years from now',
                position: 'insideBottom',
                offset: -2,
                fill: 'var(--text-subtle)',
                fontSize: 10,
              }}
            />
            <YAxis
              tick={tick}
              tickLine={false}
              axisLine={false}
              width={yWidth}
              tickFormatter={(v: number) => formatCompact(v, currency)}
            />
            <Tooltip
              {...TOOLTIP}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0]?.payload as (typeof data)[number] | undefined;
                if (!d) return null;
                return (
                  <ChartTooltip
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
              activeDot={false}
              fill="transparent"
              {...entrance}
            />
            <Area
              type="monotone"
              dataKey="band10to25"
              stackId="fan"
              stroke="none"
              activeDot={false}
              fill="url(#fan-outer)"
              {...entrance}
            />
            <Area
              type="monotone"
              dataKey="band25to75"
              stackId="fan"
              stroke="none"
              activeDot={false}
              fill="url(#fan-inner)"
              {...entrance}
            />
            <Area
              type="monotone"
              dataKey="band75to90"
              stackId="fan"
              stroke="none"
              activeDot={false}
              fill="url(#fan-outer)"
              {...entrance}
            />
            <Line
              type="monotone"
              dataKey="p50"
              stroke="var(--seq-700)"
              strokeWidth={2.25}
              dot={false}
              activeDot={false}
              {...entrance}
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
      <div className="legend mt-2">
        <LegendItem colour="var(--seq-700)">Median path</LegendItem>
        <LegendItem colour="var(--seq-300)">Middle 50% of outcomes</LegendItem>
        <LegendItem colour="var(--seq-100)">10th-90th percentile</LegendItem>
        <LegendItem colour="var(--warning)">Target</LegendItem>
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
  const { narrow, tick } = useChartAxis();
  const entrance = useChartEntrance();
  const data = result.histogram.map((b) => ({
    label: formatCompact(b.bucketStart, currency),
    start: b.bucketStart,
    end: b.bucketEnd,
    count: b.count,
    // Buckets below the target are the failure region - a polarity, so it gets
    // the status colour rather than another series hue.
    short: b.bucketEnd < result.target,
  }));

  const shortCount = data.filter((d) => d.short).length;
  // The first bucket that clears the target: where the line belongs.
  const targetIndex = data.findIndex((d) => !d.short);

  return (
    <div>
      <div className="chart-frame" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 10, left: 0, bottom: 0 }} barCategoryGap={2}>
            <CartesianGrid stroke="var(--grid)" strokeDasharray="0" vertical={false} />
            <XAxis
              dataKey="label"
              tick={tick}
              tickLine={false}
              axisLine={{ stroke: 'var(--grid)' }}
              interval={narrow ? 5 : 3}
            />
            <YAxis tick={tick} tickLine={false} axisLine={false} width={34} />
            <Tooltip
              {...TOOLTIP}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0]?.payload as (typeof data)[number] | undefined;
                if (!d) return null;
                return (
                  <ChartTooltip
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
            {/*
             * The target, drawn on the axis rather than only implied by the
             * bar colours. Without it a chart of all-teal bars reads as a bug
             * - "why is nothing red?" - when it is in fact the plan clearing
             * the target on every path. The line is placed on the first
             * bucket that meets it, because this axis is categorical.
             */}
            {targetIndex >= 0 && (
              <ReferenceLine
                x={data[targetIndex]?.label}
                stroke="var(--warning)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                label={{
                  value: 'Target',
                  position: 'insideTopRight',
                  fill: 'var(--warning)',
                  fontSize: 10,
                  fontWeight: 700,
                }}
              />
            )}
            <Bar dataKey="count" radius={[4, 4, 0, 0]} {...entrance}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.short ? 'var(--negative)' : 'var(--seq-500)'} fillOpacity={0.85} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="legend mt-2">
        <LegendItem colour="var(--seq-500)">Meets the target</LegendItem>
        {/* Only claimed when a bar actually carries it. */}
        {shortCount > 0 && <LegendItem colour="var(--negative)">Falls short</LegendItem>}
        <LegendItem colour="var(--warning)" line>
          Target {formatCompact(result.target, currency)}
        </LegendItem>
      </div>
      {shortCount === 0 && result.target > 0 && (
        <p className="text-xs text-subtle mt-2">
          No bar falls short: on these assumptions every simulated path clears the target, so the
          spread is about how much you end up with rather than whether you get there.
        </p>
      )}
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
 * Hovering a segment names it above the bar; the bar itself does not change.
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
  /*
   * Without a label the bar is inline in a table cell rather than heading its
   * own block. It then gets no header row at all - an empty one still
   * reserved a line of text above every bar, which is what pushed the mix
   * column out of line with the rest of its row - and its segments have to be
   * wider before a percentage will fit inside them.
   */
  const inline = label === '';
  const labelFloor = inline ? 13 : 7;

  const readout = (ac: AssetClass) =>
    `${ASSET_LABELS[ac]} · ${((weights[ac] ?? 0) * 100).toFixed(1)}%` +
    (total && currency ? ` · ${formatCompact((weights[ac] ?? 0) * total, currency)}` : '');

  return (
    <div>
      {!inline && (
        <div className="row-between mb-2">
          <span className="text-sm strong">{label}</span>
          {hovered && <span className="text-xs text-muted">{readout(hovered)}</span>}
        </div>
      )}
      <div
        className={`composition${inline ? ' composition-inline' : ''}`}
        role="img"
        aria-label={`${label ? `${label}: ` : ''}${present.map((ac) => `${ASSET_LABELS[ac]} ${((weights[ac] ?? 0) * 100).toFixed(0)}%`).join(', ')}`}
      >
        {present.map((ac) => {
          const pct = (weights[ac] ?? 0) * 100;
          return (
            <div
              key={ac}
              className="composition-segment"
              style={{ flex: `0 0 calc(${pct}% - 2px)`, background: ASSET_COLOUR[ac] }}
              /* The inline bar has nowhere to put a readout, so every segment
                 carries its own - including the slivers too narrow to label. */
              title={readout(ac)}
              data-spot={ASSET_COLOUR[ac]}
              onMouseEnter={() => setHovered(ac)}
              onMouseLeave={() => setHovered(null)}
            >
              {pct >= labelFloor && <span className="composition-label">{pct.toFixed(0)}%</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AllocationLegend({ weights }: { weights: AllocationWeights }) {
  return (
    <div className="legend mt-3">
      {ASSET_CLASSES.filter((ac) => (weights[ac] ?? 0) > 0.001).map((ac) => (
        <LegendItem key={ac} colour={ASSET_COLOUR[ac]}>
          {ASSET_LABELS[ac]}
        </LegendItem>
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
                className={`drift-bar ${over ? 'over' : 'under'}`}
                style={{ width: `${width}%`, left: over ? '50%' : `calc(50% - ${width}%)` }}
                data-spot={over ? 'var(--warning)' : 'var(--info)'}
              />
            </div>
            <span className={`text-xs num text-right ${over ? 'text-warning' : ''}`.trim()}>
              {over ? '+' : ''}
              {(d.deltaPct * 100).toFixed(1)} pt
            </span>
          </div>
        );
      })}
      <div className="legend mt-1">
        <LegendItem colour="var(--info)">Below target</LegendItem>
        <LegendItem colour="var(--warning)">Above target</LegendItem>
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
 * The % funded axis: 0-100% in 25% steps, extended in 25% steps to fit a goal
 * above 100%. Past 200% the step coarsens so the axis keeps a handful of clean
 * labels starting at 0% - at 25% steps a 600% goal meant 25 ticks, which the
 * chart thinned to an uneven set that dropped the 0% label.
 */
export function fundedAxis(dataMax: number): { top: number; ticks: number[] } {
  const step =
    dataMax <= 200 ? 25 : ([50, 100, 250, 500, 1000, 2500, 5000].find((s) => Math.ceil(dataMax / s) <= 8) ?? 10_000);
  const top = Math.max(100, Math.ceil(dataMax / step) * step);
  return { top, ticks: Array.from({ length: top / step + 1 }, (_, i) => i * step) };
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
            <div className="row-between mb-1">
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
              data-spot={p.scored ? `var(--${tone})` : undefined}
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
            <div className="text-xs text-subtle mt-1">{p.summary}</div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The five pillars as a radar.
 *
 * The meters below it answer "how is Debt doing"; this answers "what shape is
 * this plan" - whether the weakness is one spike or a flat, evenly thin
 * profile, which is the thing a reader cannot assemble from five separate
 * bars. The two forms carry the same numbers on purpose: the radar is read at
 * a glance and the meters are read for the value.
 *
 * It is drawn only when every pillar is scored. A radar with a missing axis
 * collapsed to zero draws a shape that says "bad here" when the truth is
 * "not measured", and that is a worse lie than showing nothing.
 */
export function WellnessRadar({
  wellness,
  height = 250,
}: {
  wellness: WellnessScore;
  height?: number;
}) {
  const entrance = useChartEntrance(1100);
  if (!wellness.dataComplete) return null;

  const data = wellness.pillars.map((p) => ({
    pillar: p.name,
    score: p.score,
    weight: p.weight,
    summary: p.summary,
  }));

  return (
    <div className="chart-frame" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} outerRadius="80%" margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <defs>
            <radialGradient id="radar-fill" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--accent-strong)" stopOpacity={0.42} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.16} />
            </radialGradient>
          </defs>
          <PolarGrid stroke="var(--grid)" />
          <PolarAngleAxis
            dataKey="pillar"
            tick={{ fill: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font)' }}
          />
          {/* The rings are the scale; numbering them as well just adds ink. */}
          <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
          <Tooltip
            {...TOOLTIP}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0]?.payload as (typeof data)[number] | undefined;
              if (!d) return null;
              return (
                <ChartTooltip
                  label={d.pillar}
                  rows={[
                    { name: 'Score', value: `${d.score}/100`, colour: 'var(--accent)' },
                    { name: 'Weight in total', value: `${(d.weight * 100).toFixed(0)}%` },
                  ]}
                />
              );
            }}
          />
          <Radar
            dataKey="score"
            stroke="var(--accent)"
            strokeWidth={2}
            fill="url(#radar-fill)"
            dot={{ r: 3, fill: 'var(--accent)', stroke: 'none' }}
            {...entrance}
          />
        </RadarChart>
      </ResponsiveContainer>
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
        <div className="expense-row" key={b.category}>
          <span className="text-muted truncate" title={b.category}>
            {b.category}
          </span>
          {/* One hue: this is magnitude, not identity. The largest category
              is emphasised so the eye lands on what matters. */}
          <span className="bar expense-track" data-spot={`var(--${i === 0 ? 'series-1' : 'seq-300'})`}>
            <span
              className={`bar-fill ${i === 0 ? 'lead' : 'rest'}`}
              style={{ width: `${(b.amount / max) * 100}%` }}
            />
          </span>
          <span className="num text-right">{formatCompact(b.amount, currency)}</span>
          <span className="text-xs text-subtle num text-right">{(b.sharePct * 100).toFixed(0)}%</span>
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
  height,
}: {
  rows: { label: string; value: number; delta: number }[];
  baseline: number;
  currency: Currency;
  /** By default the chart is as tall as its rows need. */
  height?: number;
}) {
  const { narrow, tick } = useChartAxis();
  const entrance = useChartEntrance();
  const nameLimit = narrow ? 16 : 26;
  const data = rows.map((r) => ({
    ...r,
    name: r.label.length > nameLimit ? `${r.label.slice(0, nameLimit - 1)}…` : r.label,
  }));
  // A fixed height left two bars floating in a tall empty frame.
  const frameHeight = height ?? Math.max(136, data.length * 36 + 60);

  return (
    <div>
      <div className="chart-frame" style={{ height: frameHeight }}>
        <ResponsiveContainer width="100%" height="100%">
          {/* Top margin holds the "Today" label over the baseline. */}
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 20, right: narrow ? 28 : 58, left: 4, bottom: 4 }}
          >
            <CartesianGrid stroke="var(--grid)" strokeDasharray="0" horizontal={false} />
            <XAxis
              type="number"
              tick={tick}
              tickLine={false}
              axisLine={{ stroke: 'var(--grid)' }}
              tickCount={narrow ? 3 : 5}
              tickFormatter={(v: number) => formatCompact(v, currency)}
            />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ ...tick, fontFamily: 'var(--font)' }}
              tickLine={false}
              axisLine={false}
              width={narrow ? 112 : 168}
            />
            <Tooltip
              {...TOOLTIP}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0]?.payload as (typeof data)[number] | undefined;
                if (!d) return null;
                return (
                  <ChartTooltip
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
            <Bar dataKey="value" radius={[0, 4, 4, 0]} barSize={18} {...entrance}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.delta >= 0 ? 'var(--positive)' : 'var(--negative)'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="legend mt-2">
        <LegendItem colour="var(--positive)">Better than today's plan</LegendItem>
        <LegendItem colour="var(--negative)">Worse</LegendItem>
        <LegendItem colour="var(--text-subtle)" line>
          Current plan
        </LegendItem>
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
    <details className="disclosure">
      <summary>{label}</summary>
      <div className="disclosure-body table-wrap">{children}</div>
    </details>
  );
}
