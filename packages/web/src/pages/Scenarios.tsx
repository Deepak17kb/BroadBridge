import { useEffect, useMemo, useRef, useState } from 'react';
import {
  formatCompact,
  formatPercent,
  runScenario,
  SCENARIO_PRESETS,
  type ScenarioLevers,
  type ScenarioResult,
} from '@wealth/shared';
import { useLoadedProfile } from '../state/ProfileContext';
import { AssumptionList, Badge, Callout, Card, Slider, Stat } from '../components/ui';
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

export function Scenarios() {
  const { profile, snapshot } = useLoadedProfile();
  const { currency } = profile;

  const [levers, setLevers] = useState<ScenarioLevers>(EMPTY);
  const [settled, setSettled] = useState<ScenarioLevers>(EMPTY);
  const [dragging, setDragging] = useState(false);
  const [saved, setSaved] = useState<{ label: string; levers: ScenarioLevers }[]>([]);
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

  const comparison = useMemo(() => {
    const rows = [
      { label: 'Your scenario', levers: settled },
      ...saved,
    ];
    return rows.map((r) => {
      const res = runScenario({ profile, levers: r.levers, baseline: snapshot, paths: 600 });
      return {
        label: r.label,
        value: res.snapshot.netWorthAtRetirement,
        delta: res.deltaVsBaseline.netWorthAtRetirement,
        readiness: res.snapshot.retirementReadiness,
        success: res.monteCarlo.successProbability,
        goals: res.snapshot.goalsOnTrack,
        goalsTotal: res.snapshot.goalsTotal,
      };
    });
  }, [profile, snapshot, settled, saved]);

  const set = <K extends keyof ScenarioLevers>(key: K, value: ScenarioLevers[K]) =>
    setLevers((current) => ({ ...current, [key]: value }));

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

            <div className="divider" />
            <div className="row-wrap">
              <button
                className="btn btn-sm"
                disabled={!hasLevers || saved.length >= 3}
                onClick={() =>
                  setSaved((s) => [...s, { label: result.label.slice(0, 40), levers: settled }])
                }
                title={saved.length >= 3 ? 'Up to three saved scenarios' : 'Pin this scenario for comparison'}
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
              subtitle={saved.length ? 'Your scenario against the ones you pinned' : 'Pin a scenario to compare alternatives side by side'}
            >
              <ScenarioComparison
                rows={comparison}
                baseline={snapshot.retirement.projectedCorpus}
                currency={currency}
              />
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
