import { useEffect, useMemo, useRef, useState } from 'react';
import {
  formatCompact,
  formatPercent,
  runScenario,
  SCENARIO_PRESETS,
  type AllocationWeights,
  type ScenarioLevers,
  type ScenarioResult,
} from '@wealth/shared';
import { api } from '../lib/api';
import { useLoadedProfile } from '../state/ProfileContext';
import { AssumptionList, Badge, Callout, Card, Slider, Stat } from '../components/ui';
import { RiskLadder, useRiskLadder, type LadderRow } from '../components/RiskLadder';
import { MonteCarloFan, OutcomeHistogram, ScenarioComparison, TableToggle } from '../components/charts/Charts';

/**
 * The Scenario Lab.
 *
 * Every lever recomputes *in the browser* using the shared engine, which is
 * what makes dragging a slider feel like a live model rather than a form
 * submission. A 2,000-path Monte Carlo over 20 years is roughly half a million
 * multiplications - a few milliseconds - so the constraint is React re-render
 * cost, not the simulation.
 *
 * Two concessions to that: the simulation is debounced through a deferred
 * lever state, and the path count drops while a slider is moving and rises
 * again when it settles. The result is a smooth drag and a precise final answer.
 */

const EMPTY: ScenarioLevers = {};

/** The comparison endpoint caps at six, so the pin control does too. */
const MAX_PINNED = 6;

interface ComparisonRow {
  label: string;
  value: number;
  delta: number;
  readiness: number;
  success: number;
  goals: number;
  goalsTotal: number;
}

/** One mapping for both sources, so a server row and a local row cannot differ in shape. */
function toComparisonRow(label: string, result: ScenarioResult): ComparisonRow {
  return {
    label,
    value: result.snapshot.netWorthAtRetirement,
    delta: result.deltaVsBaseline.netWorthAtRetirement,
    readiness: result.snapshot.retirementReadiness,
    success: result.monteCarlo.successProbability,
    goals: result.snapshot.goalsOnTrack,
    goalsTotal: result.snapshot.goalsTotal,
  };
}

export function Scenarios() {
  const { profile, snapshot } = useLoadedProfile();
  const { currency } = profile;

  const [levers, setLevers] = useState<ScenarioLevers>(EMPTY);
  const [settled, setSettled] = useState<ScenarioLevers>(EMPTY);
  const [dragging, setDragging] = useState(false);
  const [saved, setSaved] = useState<{ label: string; levers: ScenarioLevers }[]>([]);
  const [pinnedRows, setPinnedRows] = useState<ComparisonRow[] | null>([]);
  const [pinnedLocally, setPinnedLocally] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  // The interactive value updates instantly; the expensive simulation waits for
  // the drag to settle.
  useEffect(() => {
    setDragging(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setSettled(levers);
      setDragging(false);
    }, 180);
    return () => window.clearTimeout(timer.current);
  }, [levers]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const result = useMemo<ScenarioResult>(
    () =>
      runScenario({
        profile,
        levers: settled,
        baseline: snapshot,
        // Fewer paths mid-drag keeps the fan chart responsive; the settled run
        // uses the full count.
        paths: dragging ? 600 : 2500,
      }),
    [profile, settled, snapshot, dragging],
  );

  /*
   * Pinned scenarios are compared server-side.
   *
   * `/scenarios/compare` runs all of them against ONE baseline it builds once,
   * which is the guarantee the endpoint exists to provide - comparing rows that
   * were each scored against their own baseline is how a comparison quietly
   * drifts. The live row stays local so dragging a slider is still instant, and
   * the same engine runs on both sides, so the two cannot disagree.
   *
   * The request fires when the pinned set changes or the profile is saved, not
   * on every drag: the pinned rows do not depend on the live levers.
   */
  useEffect(() => {
    if (saved.length === 0) {
      setPinnedRows([]);
      setPinnedLocally(false);
      return;
    }
    let cancelled = false;
    api
      .compareScenarios(
        profile.id,
        saved.map((s) => ({ label: s.label, levers: s.levers })),
      )
      .then((res) => {
        if (cancelled) return;
        setPinnedRows(res.results.map((r) => toComparisonRow(r.label, r)));
        setPinnedLocally(false);
      })
      .catch(() => {
        // Offline, or the profile has not been persisted yet. Fall back to the
        // browser's own engine rather than showing an empty comparison.
        if (cancelled) return;
        setPinnedRows(null);
        setPinnedLocally(true);
      });
    return () => {
      cancelled = true;
    };
  }, [profile.id, profile.updatedAt, saved]);

  const comparison = useMemo(() => {
    const live = toComparisonRow(
      'Your scenario',
      runScenario({ profile, levers: settled, baseline: snapshot, paths: 600 }),
    );
    const pinned =
      pinnedRows ??
      saved.map((s) =>
        toComparisonRow(
          s.label,
          runScenario({ profile, levers: s.levers, baseline: snapshot, paths: 600 }),
        ),
      );
    return [live, ...pinned];
  }, [profile, snapshot, settled, saved, pinnedRows]);

  const set = <K extends keyof ScenarioLevers>(key: K, value: ScenarioLevers[K]) =>
    setLevers((current) => ({ ...current, [key]: value }));

  const ladder = useRiskLadder(profile.id);

  /*
   * Which ladder row the override currently matches. Compared by weights rather
   * than stored as a bucket name, so a preset or a restored scenario that sets
   * an allocation directly still lights up the right row.
   */
  const selectedBucket = useMemo(() => {
    const chosen = levers.allocation;
    if (!chosen) return undefined;
    const match = ladder.find((row: LadderRow) =>
      Object.entries(row.weights).every(
        ([k, v]) => Math.abs((chosen[k as keyof AllocationWeights] ?? 0) - v) < 1e-9,
      ),
    );
    return match?.bucket;
  }, [levers.allocation, ladder]);

  const hasLevers = Object.values(settled).some((v) => v !== undefined);
  const income = snapshot.cashflow.monthlyIncome || 100000;

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Scenario Lab</h1>
        <p>
          Change something about your plan and watch the consequence. Every number updates as you
          drag, and each scenario is scored against thousands of simulated market paths rather than a
          single optimistic projection.
        </p>
      </header>

      {/* Presets first - a blank slider panel is intimidating, and these are
          the questions people actually arrive with. */}
      <Card title="Start from a common question" subtitle="Each one sets the levers below, which you can then adjust">
        <div className="row-wrap">
          {SCENARIO_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className="btn btn-sm"
              title={preset.description}
              onClick={() => setLevers(preset.levers)}
            >
              {preset.label}
            </button>
          ))}
          <button className="btn btn-sm btn-ghost" onClick={() => setLevers(EMPTY)}>
            Reset to my current plan
          </button>
        </div>
      </Card>

      <div className="grid grid-sidebar-left">
        <Card title="Levers" subtitle="Anything left untouched stays as it is today">
          <div className="stack">
            <Slider
              label="Save more each month"
              value={levers.extraMonthlySavings ?? 0}
              min={0}
              max={Math.round(income * 0.6)}
              step={Math.max(500, Math.round(income / 200) * 100)}
              onChange={(v) => set('extraMonthlySavings', v || undefined)}
              format={(v) => (v ? `+${formatCompact(v, currency)}` : 'No change')}
              hint={
                snapshot.cashflow.monthlySurplus > 0
                  ? `Your uncommitted surplus is ${formatCompact(snapshot.cashflow.monthlySurplus, currency)}`
                  : 'You have no free surplus today, so this would need a spending cut first'
              }
            />

            <Slider
              label="Change your spending"
              value={levers.expenseMultiplier ?? 1}
              min={0.6}
              max={1.3}
              step={0.01}
              onChange={(v) => set('expenseMultiplier', v === 1 ? undefined : v)}
              format={(v) =>
                v === 1 ? 'No change' : `${v < 1 ? '-' : '+'}${Math.abs((1 - v) * 100).toFixed(0)}%`
              }
              hint="Money freed by spending less is assumed to be invested, not respent"
            />

            <Slider
              label="Retire earlier or later"
              value={levers.retirementAgeDelta ?? 0}
              min={-10}
              max={10}
              step={1}
              onChange={(v) => set('retirementAgeDelta', v || undefined)}
              format={(v) =>
                v === 0 ? `Age ${profile.retirementAge}` : `Age ${profile.retirementAge + v} (${v > 0 ? '+' : ''}${v}y)`
              }
              hint="This moves the number twice - more or fewer years of both saving and spending"
            />

            <Slider
              label="Invest a lump sum today"
              value={levers.lumpSum ?? 0}
              min={0}
              max={Math.round(income * 24)}
              step={Math.max(10000, Math.round(income / 10) * 1000)}
              onChange={(v) => set('lumpSum', v || undefined)}
              format={(v) => (v ? formatCompact(v, currency) : 'None')}
              hint="A bonus, maturity or sale proceeds"
            />

            <div className="divider" />
            <div className="stat-label">Stress tests</div>

            <Slider
              label="Market crash"
              value={levers.marketShockPct ?? 0}
              min={-0.6}
              max={0}
              step={0.05}
              onChange={(v) => {
                if (v === 0) {
                  setLevers((c) => ({ ...c, marketShockPct: undefined, shockYear: undefined }));
                } else {
                  setLevers((c) => ({ ...c, marketShockPct: v, shockYear: c.shockYear ?? 3 }));
                }
              }}
              format={(v) => (v === 0 ? 'None' : `${(v * 100).toFixed(0)}%`)}
              hint="A one-off drawdown, with contributions continuing through it"
            />

            {levers.marketShockPct !== undefined && (
              <Slider
                label="…in which year"
                value={levers.shockYear ?? 3}
                min={1}
                max={Math.max(2, snapshot.retirement.yearsToRetirement - 1)}
                step={1}
                onChange={(v) => set('shockYear', v)}
                format={(v) => `Year ${v}`}
                hint="A crash close to retirement hurts far more than an early one"
              />
            )}

            <Slider
              label="Career break"
              value={levers.careerBreakMonths ?? 0}
              min={0}
              max={36}
              step={1}
              onChange={(v) => set('careerBreakMonths', v || undefined)}
              format={(v) => (v ? `${v} months` : 'None')}
              hint="Contributions pause; compounding does not"
            />

            <Slider
              label="Inflation runs at"
              value={levers.inflationPct ?? snapshot.assumptions.inflationPct}
              min={0.02}
              max={0.14}
              step={0.005}
              onChange={(v) =>
                set('inflationPct', Math.abs(v - snapshot.assumptions.inflationPct) < 0.0001 ? undefined : v)
              }
              format={(v) => formatPercent(v, 1)}
              hint={`Your plan currently assumes ${formatPercent(snapshot.assumptions.inflationPct, 1)}`}
            />

            <Slider
              label="Annual pay rise"
              value={levers.incomeGrowthPct ?? profile.cashflow.annualIncomeGrowthPct}
              min={0}
              max={0.25}
              step={0.01}
              onChange={(v) =>
                set(
                  'incomeGrowthPct',
                  Math.abs(v - profile.cashflow.annualIncomeGrowthPct) < 0.0001 ? undefined : v,
                )
              }
              format={(v) => formatPercent(v, 0)}
            />

            {/* Allocation override. The engine has always accepted one; until
                now nothing in the UI could set it, so the one lever that changes
                *how* the money is invested was unreachable. Shown as the ladder
                rather than six weight sliders: the question a user actually has
                is "what if I moved up or down a risk level", and the ladder is
                the only place the cost of that move is visible. */}
            {ladder.length > 0 && (
              <>
                <div className="divider" />
                <div className="stat-label">Invest differently</div>
                <RiskLadder
                  rows={ladder}
                  yourBucket={snapshot.risk.bucket}
                  selectedBucket={selectedBucket}
                  onSelect={(row) =>
                    set(
                      'allocation',
                      row.bucket === selectedBucket
                        ? undefined
                        : (row.weights as AllocationWeights),
                    )
                  }
                  footnote={
                    selectedBucket
                      ? `Modelling the ${selectedBucket} mix. Click it again to go back to your own allocation.`
                      : 'Click a risk level to model that mix instead of your current one. Expected return and volatility both move — the scenario below prices the trade.'
                  }
                />
              </>
            )}

            <div className="divider" />
            <div className="row-wrap">
              <button
                className="btn btn-sm"
                disabled={!hasLevers || saved.length >= MAX_PINNED}
                onClick={() =>
                  setSaved((s) => [...s, { label: result.label.slice(0, 40), levers: settled }])
                }
                title={
                  saved.length >= MAX_PINNED
                    ? `Up to ${MAX_PINNED} pinned scenarios`
                    : 'Pin this scenario for comparison'
                }
              >
                Pin for comparison
              </button>
              {saved.length > 0 && (
                <button className="btn btn-sm btn-ghost" onClick={() => setSaved([])}>
                  Clear pinned ({saved.length})
                </button>
              )}
            </div>
          </div>
        </Card>

        <div className="stack">
          {/* Outcome headline. The deltas are the point - two large absolute
              numbers side by side make the reader do the subtraction. */}
          <Card
            title={hasLevers ? result.label : 'Your current plan'}
            subtitle={dragging ? 'Recalculating…' : `Scored against ${result.monteCarlo.paths.toLocaleString('en-US')} simulated market paths`}
            actions={dragging ? <span className="spinner" /> : undefined}
          >
            <div className="grid grid-4" style={{ gap: 14 }}>
              <Stat
                label="Corpus at retirement"
                value={formatCompact(result.snapshot.netWorthAtRetirement, currency)}
                delta={hasLevers ? { value: result.deltaVsBaseline.netWorthAtRetirement, currency } : undefined}
                meta="nominal, at the retirement date"
              />
              <Stat
                label="Retirement funded"
                value={formatPercent(result.snapshot.retirementReadiness, 0)}
                delta={
                  hasLevers
                    ? { value: Math.round(result.deltaVsBaseline.retirementReadiness * 100), suffix: ' pts' }
                    : undefined
                }
                tone={result.snapshot.retirementReadiness >= 0.9 ? 'positive' : 'warning'}
              />
              <Stat
                label="Chance of success"
                value={formatPercent(result.monteCarlo.successProbability, 0)}
                meta={
                  result.monteCarlo.successProbability >= 0.7
                    ? 'In the range planners aim for'
                    : 'Below the 70% planners target'
                }
                tone={result.monteCarlo.successProbability >= 0.7 ? 'positive' : 'warning'}
              />
              <Stat
                label="Goals on track"
                value={`${result.snapshot.goalsOnTrack} / ${result.snapshot.goalsTotal}`}
                delta={hasLevers ? { value: result.deltaVsBaseline.goalsOnTrack, suffix: '' } : undefined}
                tone={result.snapshot.goalsOnTrack === result.snapshot.goalsTotal ? 'positive' : 'neutral'}
              />
            </div>

            <div style={{ marginTop: 14 }}>
              <Callout tone={result.deltaVsBaseline.netWorthAtRetirement >= 0 ? 'positive' : 'warning'}>
                {result.explanation}
              </Callout>
            </div>
          </Card>

          <Card
            title="Range of outcomes"
            subtitle="The spread matters more than the average. A single projected line is the least likely outcome of all."
          >
            <MonteCarloFan result={result.monteCarlo} currency={currency} />
            <div className="grid grid-3" style={{ marginTop: 16, gap: 14 }}>
              <Stat
                label="Bad run (10th pct)"
                value={formatCompact(result.monteCarlo.p10, currency)}
                meta="in today's money"
                tone="negative"
              />
              <Stat
                label="Median"
                value={formatCompact(result.monteCarlo.median, currency)}
                meta="in today's money"
              />
              <Stat
                label="Good run (90th pct)"
                value={formatCompact(result.monteCarlo.p90, currency)}
                meta="in today's money"
                tone="positive"
              />
            </div>
            <TableToggle label="Percentile bands by year">
              <table className="data">
                <thead>
                  <tr>
                    <th>Year</th>
                    <th className="right">10th</th>
                    <th className="right">25th</th>
                    <th className="right">Median</th>
                    <th className="right">75th</th>
                    <th className="right">90th</th>
                  </tr>
                </thead>
                <tbody>
                  {result.monteCarlo.bands
                    .filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / 12)) === 0)
                    .map((b) => (
                      <tr key={b.year}>
                        <td className="num">{b.year}</td>
                        <td className="right num">{formatCompact(b.p10, currency)}</td>
                        <td className="right num">{formatCompact(b.p25, currency)}</td>
                        <td className="right num strong">{formatCompact(b.p50, currency)}</td>
                        <td className="right num">{formatCompact(b.p75, currency)}</td>
                        <td className="right num">{formatCompact(b.p90, currency)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </TableToggle>
          </Card>

          <div className="grid grid-2">
            <Card title="Where the simulations landed" subtitle="Each bar is a band of final outcomes">
              <OutcomeHistogram result={result.monteCarlo} currency={currency} />
            </Card>

            <Card
              title="Option comparison"
              subtitle={
                saved.length
                  ? `Your scenario against the ${saved.length} you pinned, all scored on one baseline`
                  : `Pin up to ${MAX_PINNED} scenarios to compare alternatives side by side`
              }
            >
              <ScenarioComparison
                rows={comparison}
                baseline={snapshot.retirement.projectedCorpus}
                currency={currency}
              />
              {pinnedLocally && (
                <p className="text-xs text-subtle" style={{ marginTop: 8 }}>
                  Scored in your browser — the server comparison was unreachable. Same engine, same
                  numbers; the only thing lost is the shared baseline.
                </p>
              )}
              <TableToggle>
                <table className="data">
                  <thead>
                    <tr>
                      <th>Scenario</th>
                      <th className="right">Corpus</th>
                      <th className="right">vs today</th>
                      <th className="right">Funded</th>
                      <th className="right">Success</th>
                      <th className="right">Goals</th>
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.map((c) => (
                      <tr key={c.label}>
                        <td>{c.label}</td>
                        <td className="right num">{formatCompact(c.value, currency)}</td>
                        <td className={`right num ${c.delta >= 0 ? 'text-positive' : 'text-negative'}`}>
                          {c.delta >= 0 ? '+' : '-'}
                          {formatCompact(Math.abs(c.delta), currency)}
                        </td>
                        <td className="right num">{formatPercent(c.readiness, 0)}</td>
                        <td className="right num">{formatPercent(c.success, 0)}</td>
                        <td className="right num">
                          {c.goals}/{c.goalsTotal}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableToggle>
            </Card>
          </div>

          <Card title="Goals under this scenario" subtitle="Extra savings are spread across shortfalls in proportion to their size">
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Goal</th>
                    <th className="right">Needed</th>
                    <th className="right">Projected</th>
                    <th className="right">Funded</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.goalProjections.map((g) => {
                    const before = snapshot.goalProjections.find((b) => b.goalId === g.goalId);
                    const moved = before && before.onTrack !== g.onTrack;
                    return (
                      <tr key={g.goalId}>
                        <td>
                          {g.goalName}
                          {moved && (
                            <Badge tone={g.onTrack ? 'positive' : 'negative'}>
                              {g.onTrack ? 'now on track' : 'falls off track'}
                            </Badge>
                          )}
                        </td>
                        <td className="right num">{formatCompact(g.inflatedTarget, currency)}</td>
                        <td className="right num">{formatCompact(g.projectedCorpus, currency)}</td>
                        <td className="right num">{formatPercent(g.fundedRatio, 0)}</td>
                        <td>
                          <Badge tone={g.onTrack ? 'positive' : 'warning'}>
                            {g.onTrack ? 'Funded' : `Short ${formatCompact(Math.abs(g.surplus), currency)}`}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <AssumptionList assumptions={result.assumptions} title="Everything this scenario assumed" />
        </div>
      </div>
    </div>
  );
}
