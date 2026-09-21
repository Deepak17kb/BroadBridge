import { useEffect, useState } from 'react';
import {
  ASSET_CLASSES,
  ASSET_LABELS,
  DEFAULT_ASSUMPTIONS,
  HEALTH_COVER_AGE_BANDS,
  formatCompact,
  formatPercent,
  healthCoverTarget,
  type AssetClass,
} from '@wealth/shared';
import { api } from '../lib/api';
import { useLoadedProfile, useProfile } from '../state/ProfileContext';
import { Badge, Callout, Card, Slider, Stat } from '../components/ui';
import { RiskLadder, useRiskLadder } from '../components/RiskLadder';

/**
 * The assumptions ledger, made editable.
 *
 * The brief asks for assumptions to be visible; this goes further and makes
 * them the user's. Every projection on the platform reads from here, so raising
 * inflation or cutting the equity return re-scores the whole plan live - which
 * is the fastest way to show someone that a "you will have 6 crore" headline is
 * a consequence of assumptions rather than a fact about the future.
 */
export function Assumptions() {
  const { profile, snapshot } = useLoadedProfile();
  const { updateProfile, saveState } = useProfile();
  const { currency } = profile;

  const assumptions = snapshot.assumptions;

  const [knowledge, setKnowledge] = useState<{ id: string; title: string; tags: string[] }[]>([]);

  // Keyed on the save state, not on `updatedAt`: the endpoint reads the stored
  // profile, and `updatedAt` bumps on every keystroke while the save is still
  // debounced - refetching then would just re-fetch the pre-edit figures.
  const ladder = useRiskLadder(profile.id, saveState === 'saved');

  useEffect(() => {
    api
      .capabilities()
      .then((c) => setKnowledge(c.knowledgeBase))
      .catch(() => setKnowledge([]));
  }, []);

  const setAssumption = (mutate: (draft: NonNullable<typeof profile.assumptionOverrides>) => void) =>
    updateProfile((draft) => {
      draft.assumptionOverrides = { ...(draft.assumptionOverrides ?? {}) };
      mutate(draft.assumptionOverrides);
    });

  const isOverridden = (key: keyof typeof DEFAULT_ASSUMPTIONS) =>
    profile.assumptionOverrides?.[key] !== undefined;

  const anyOverride = Object.keys(profile.assumptionOverrides ?? {}).length > 0;

  // Same call the rule engine makes, so the ledger and the action can never
  // quote different targets.
  const healthTarget = healthCoverTarget({
    annualIncome: snapshot.cashflow.monthlyIncome * 12,
    age: profile.age,
    dependents: profile.dependents,
    assumptions,
  });
  const healthGap = healthTarget - (profile.healthInsuranceCover ?? 0);

  return (
    <div className="stack">
      <header className="page-head">
        <div className="row-between">
          <div>
            <h1>Assumptions</h1>
            <p>
              Every projection on this platform rests on the numbers below. They are long-run
              planning figures, not forecasts — and they are yours to change. Move any of them and
              the whole plan re-scores immediately.
            </p>
          </div>
          {anyOverride && (
            <button
              className="btn"
              onClick={() => updateProfile((d) => void (d.assumptionOverrides = undefined))}
            >
              Reset to house view
            </button>
          )}
        </div>
      </header>

      <Callout tone="warning">
        These are illustrative planning assumptions applied to synthetic data. They are not
        forecasts, not a promise of returns, and nothing on this platform is financial advice.
      </Callout>

      {/* Live effect of the current assumption set. */}
      <div className="grid grid-4">
        <Card>
          <Stat
            label="Wellness score"
            value={`${snapshot.wellness.total}/100`}
            meta={`Grade ${snapshot.wellness.grade}`}
          />
        </Card>
        <Card>
          <Stat
            label="Retirement funded"
            value={formatPercent(snapshot.retirement.readinessRatio, 0)}
            meta={`${formatCompact(snapshot.retirement.corpusRequired, currency)} needed`}
          />
        </Card>
        <Card>
          <Stat
            label="Portfolio expected return"
            value={formatPercent(snapshot.portfolio.expectedReturnPct)}
            meta="from your allocation and these figures"
          />
        </Card>
        <Card>
          <Stat
            label="Goals on track"
            value={`${snapshot.goalProjections.filter((g) => g.onTrack).length} / ${snapshot.goalProjections.length}`}
            meta="recomputed as you edit"
          />
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Economy" subtitle="The figures that set the bar every goal has to clear">
          <div className="stack">
            <Slider
              label={`Inflation ${isOverridden('inflationPct') ? '(yours)' : '(house view)'}`}
              value={assumptions.inflationPct}
              min={0.01}
              max={0.15}
              step={0.005}
              onChange={(v) => setAssumption((a) => void (a.inflationPct = v))}
              format={(v) => formatPercent(v, 1)}
              hint={`House view ${formatPercent(DEFAULT_ASSUMPTIONS.inflationPct, 1)}. This inflates every goal target and the retirement spend.`}
            />
            <Slider
              label={`Risk-free rate ${isOverridden('riskFreePct') ? '(yours)' : '(house view)'}`}
              value={assumptions.riskFreePct}
              min={0.01}
              max={0.12}
              step={0.002}
              onChange={(v) => setAssumption((a) => void (a.riskFreePct = v))}
              format={(v) => formatPercent(v, 2)}
              hint="Used only for the Sharpe ratio - the return available without taking risk."
            />
            <Slider
              label={`Safe withdrawal rate ${isOverridden('safeWithdrawalRatePct') ? '(yours)' : '(house view)'}`}
              value={assumptions.safeWithdrawalRatePct}
              min={0.02}
              max={0.06}
              step={0.0025}
              onChange={(v) => setAssumption((a) => void (a.safeWithdrawalRatePct = v))}
              format={(v) => formatPercent(v, 2)}
              hint="The share of the corpus you can draw in year one. This single number drives the entire retirement target."
            />
            <Slider
              label={`Emergency fund target ${isOverridden('emergencyFundMonths') ? '(yours)' : '(house view)'}`}
              value={assumptions.emergencyFundMonths}
              min={1}
              max={12}
              step={1}
              onChange={(v) => setAssumption((a) => void (a.emergencyFundMonths = v))}
              format={(v) => `${v} months`}
              hint="Three months suits stable dual income; six or more suits variable income or dependents."
            />
          </div>

          <div className="divider" style={{ margin: '16px 0' }} />

          <div className="stack-sm">
            <div className="row-between text-sm">
              <span className="text-muted">Retirement corpus required</span>
              <span className="num strong">{formatCompact(snapshot.retirement.corpusRequired, currency)}</span>
            </div>
            <div className="row-between text-sm">
              <span className="text-muted">Annual spend at retirement</span>
              <span className="num">{formatCompact(snapshot.retirement.targetAnnualSpend, currency)}</span>
            </div>
            <div className="row-between text-sm">
              <span className="text-muted">Emergency fund target</span>
              <span className="num">{formatCompact(snapshot.cashflow.emergencyFundTarget, currency)}</span>
            </div>
            <p className="text-xs text-subtle" style={{ marginTop: 4 }}>
              Worth trying: drop the withdrawal rate from 3.5% to 3% and watch the required corpus
              jump by about a sixth. That sensitivity is exactly why the assumption is shown rather
              than buried.
            </p>
          </div>
        </Card>

        <Card title="Expected returns by asset class" subtitle="Long-run nominal, before tax and costs">
          <div className="stack">
            {ASSET_CLASSES.map((ac) => (
              <Slider
                key={ac}
                label={ASSET_LABELS[ac]}
                value={assumptions.expectedReturns[ac]}
                min={0}
                max={0.2}
                step={0.005}
                onChange={(v) =>
                  setAssumption((a) => {
                    a.expectedReturns = { ...(a.expectedReturns ?? {}), [ac]: v } as Record<
                      AssetClass,
                      number
                    >;
                  })
                }
                format={(v) => formatPercent(v, 1)}
                hint={`House view ${formatPercent(DEFAULT_ASSUMPTIONS.expectedReturns[ac], 1)} · volatility ${formatPercent(assumptions.volatility[ac], 1)}`}
              />
            ))}
          </div>
        </Card>
      </div>

      {/* What the edits above actually do, across every portfolio rather than
          just the user's own. Re-priced by the server from the stored profile,
          so it follows a beat behind the sliders - it refreshes on each save. */}
      {ladder.length > 0 && (
        <Card
          title="What your assumptions do to every portfolio"
          subtitle="The five model mixes, re-priced from the figures above each time your changes save"
        >
          <RiskLadder
            rows={ladder}
            yourBucket={snapshot.risk.bucket}
            footnote="Raise an expected return or a volatility above and every row moves, not just yours. That is the point of showing all five: the recommended mix is chosen against these alternatives, so changing the inputs can change which one is right for you."
          />
        </Card>
      )}

      <Card
        title="How your goals compete"
        subtitle="When the goals need more than you have, these decide who gets funded first"
      >
        <p className="text-sm text-muted">
          Each goal is scored <span className="num">priority × urgency × deficit</span>, where
          urgency is <span className="num">1 / years to the goal</span> and deficit is how far from
          funded it is. The weights below are the priority half of that, and they are yours: raise
          the aspirational weight and a nice-to-have really will take money from a must-have. The
          split this produces is on the Goals page, with what it costs the goals that lose.
        </p>
        <div className="grid grid-2" style={{ marginTop: 12 }}>
          <div className="stack">
            <Slider
              label={`Must-have weight ${isOverridden('goalWeightMustHave') ? '(yours)' : '(house view)'}`}
              value={assumptions.goalWeightMustHave}
              min={0}
              max={5}
              step={0.1}
              onChange={(v) => setAssumption((a) => void (a.goalWeightMustHave = v))}
              format={(v) => `${v.toFixed(1)}x`}
            />
            <Slider
              label={`Important weight ${isOverridden('goalWeightImportant') ? '(yours)' : '(house view)'}`}
              value={assumptions.goalWeightImportant}
              min={0}
              max={5}
              step={0.1}
              onChange={(v) => setAssumption((a) => void (a.goalWeightImportant = v))}
              format={(v) => `${v.toFixed(1)}x`}
            />
            <Slider
              label={`Aspirational weight ${isOverridden('goalWeightAspirational') ? '(yours)' : '(house view)'}`}
              value={assumptions.goalWeightAspirational}
              min={0}
              max={5}
              step={0.1}
              onChange={(v) => setAssumption((a) => void (a.goalWeightAspirational = v))}
              format={(v) => `${v.toFixed(1)}x`}
            />
          </div>
          <div className="stack">
            <Slider
              label={`Near-term window ${isOverridden('nearTermGoalMonths') ? '(yours)' : '(house view)'}`}
              value={assumptions.nearTermGoalMonths}
              min={0}
              max={60}
              step={3}
              onChange={(v) => setAssumption((a) => void (a.nearTermGoalMonths = v))}
              format={(v) => (v === 0 ? 'Off' : `${v} months`)}
              hint="A goal this close funds before longer-horizon goals of the same priority, whatever the score — there is no compounding left to rescue it."
            />
          </div>
        </div>
      </Card>

      <Card
        title="Protection"
        subtitle="What the plan assumes you are insured for, before it assumes anything about returns"
      >
        <p className="text-sm text-muted">
          Health cover is sized as the higher of a multiple of your income and an absolute floor for
          your age, then raised for each dependent. The two exist for different reasons: income alone
          under-insures a young earner, whose first serious admission costs the same as anyone
          else&apos;s, while a floor alone under-insures a high earner, whose household loses far more
          when treatment interrupts it. Age bands step at{' '}
          <span className="num">{HEALTH_COVER_AGE_BANDS.youngMaxAge}</span> and{' '}
          <span className="num">{HEALTH_COVER_AGE_BANDS.midMaxAge}</span>.
        </p>
        <div className="grid grid-2" style={{ marginTop: 12 }}>
          <div className="stack">
            <Slider
              label={`Cover as a multiple of income ${isOverridden('healthCoverIncomeMultiple') ? '(yours)' : '(house view)'}`}
              value={assumptions.healthCoverIncomeMultiple}
              min={0}
              max={2}
              step={0.05}
              onChange={(v) => setAssumption((a) => void (a.healthCoverIncomeMultiple = v))}
              format={(v) => `${v.toFixed(2)}x`}
              hint={`House view ${DEFAULT_ASSUMPTIONS.healthCoverIncomeMultiple}x annual income.`}
            />
            <Slider
              label={`Added per dependent ${isOverridden('healthCoverPerDependent') ? '(yours)' : '(house view)'}`}
              value={assumptions.healthCoverPerDependent}
              min={0}
              max={1_000_000}
              step={50_000}
              onChange={(v) => setAssumption((a) => void (a.healthCoverPerDependent = v))}
              format={(v) => formatCompact(v, currency)}
              hint="Loaded on top of whichever of the two rules binds."
            />
          </div>
          <div className="stack">
            <Slider
              label={`Floor under ${HEALTH_COVER_AGE_BANDS.youngMaxAge} ${isOverridden('healthCoverFloorUnder40') ? '(yours)' : '(house view)'}`}
              value={assumptions.healthCoverFloorUnder40}
              min={0}
              max={5_000_000}
              step={100_000}
              onChange={(v) => setAssumption((a) => void (a.healthCoverFloorUnder40 = v))}
              format={(v) => formatCompact(v, currency)}
            />
            <Slider
              label={`Floor ${HEALTH_COVER_AGE_BANDS.youngMaxAge}–${HEALTH_COVER_AGE_BANDS.midMaxAge} ${isOverridden('healthCoverFloor40To55') ? '(yours)' : '(house view)'}`}
              value={assumptions.healthCoverFloor40To55}
              min={0}
              max={5_000_000}
              step={100_000}
              onChange={(v) => setAssumption((a) => void (a.healthCoverFloor40To55 = v))}
              format={(v) => formatCompact(v, currency)}
            />
            <Slider
              label={`Floor over ${HEALTH_COVER_AGE_BANDS.midMaxAge} ${isOverridden('healthCoverFloorOver55') ? '(yours)' : '(house view)'}`}
              value={assumptions.healthCoverFloorOver55}
              min={0}
              max={5_000_000}
              step={100_000}
              onChange={(v) => setAssumption((a) => void (a.healthCoverFloorOver55 = v))}
              format={(v) => formatCompact(v, currency)}
            />
          </div>
        </div>

        <div className="divider" style={{ margin: '16px 0' }} />

        <div className="stack-sm">
          <div className="row-between text-sm">
            <span className="text-muted">Health cover this plan implies for you</span>
            <span className="num strong">{formatCompact(healthTarget, currency)}</span>
          </div>
          <div className="row-between text-sm">
            <span className="text-muted">Held today</span>
            <span className="num">{formatCompact(profile.healthInsuranceCover ?? 0, currency)}</span>
          </div>
          {healthGap > 0 ? (
            <p className="text-xs text-subtle" style={{ marginTop: 4 }}>
              A {formatCompact(healthGap, currency)} gap is not only an insurance question: an
              uncovered event is paid out of savings, so while it is open the emergency fund is
              effectively carrying it too.
            </p>
          ) : (
            <p className="text-xs text-subtle" style={{ marginTop: 4 }}>
              Cover is at or above the target these figures imply, so no health-cover action appears
              in your list.
            </p>
          )}
        </div>
      </Card>

      <Card
        title="Volatility and correlation"
        subtitle="Why diversification works, in numbers"
      >
        <p className="text-sm text-muted">
          Portfolio risk is computed from the full covariance matrix — <span className="num">w′Σw</span> —
          not by averaging the volatility of the parts. That matters: because assets are imperfectly
          correlated, a portfolio is <em>less</em> volatile than the weighted average of its holdings,
          and adding a low-correlation asset can reduce total risk even when that asset is volatile
          on its own.
        </p>
        <div className="table-wrap" style={{ marginTop: 14 }}>
          <table className="data">
            <thead>
              <tr>
                <th>Asset class</th>
                <th className="right">Expected return</th>
                <th className="right">Volatility</th>
                <th className="right">Return per unit of risk</th>
                <th className="right">Your weight</th>
              </tr>
            </thead>
            <tbody>
              {ASSET_CLASSES.map((ac) => {
                const ret = assumptions.expectedReturns[ac];
                const vol = assumptions.volatility[ac];
                return (
                  <tr key={ac}>
                    <td>{ASSET_LABELS[ac]}</td>
                    <td className="right num">{formatPercent(ret, 1)}</td>
                    <td className="right num">{formatPercent(vol, 1)}</td>
                    <td className="right num">
                      {vol > 0 ? ((ret - assumptions.riskFreePct) / vol).toFixed(2) : '—'}
                    </td>
                    <td className="right num">
                      {formatPercent(snapshot.portfolio.weights[ac] ?? 0, 1)}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td className="strong">Your portfolio</td>
                <td className="right num strong">{formatPercent(snapshot.portfolio.expectedReturnPct, 1)}</td>
                <td className="right num strong">{formatPercent(snapshot.portfolio.volatilityPct, 1)}</td>
                <td className="right num strong">{snapshot.portfolio.sharpeRatio.toFixed(2)}</td>
                <td className="right num strong">100%</td>
              </tr>
            </tbody>
          </table>
        </div>
        <details className="disclosure" style={{ marginTop: 14 }}>
          <summary>Correlation matrix</summary>
          <div className="disclosure-body table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th />
                  {ASSET_CLASSES.map((ac) => (
                    <th key={ac} className="right">
                      {ASSET_LABELS[ac].split(' ')[0]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ASSET_CLASSES.map((a) => (
                  <tr key={a}>
                    <td className="strong">{ASSET_LABELS[a]}</td>
                    {ASSET_CLASSES.map((b) => {
                      const value =
                        a === b
                          ? 1
                          : (assumptions.correlations[`${a}|${b}`] ??
                            assumptions.correlations[`${b}|${a}`] ??
                            0);
                      return (
                        <td
                          key={b}
                          className="right num"
                          style={{
                            color:
                              a === b
                                ? 'var(--text-subtle)'
                                : value < 0
                                  ? 'var(--positive)'
                                  : value > 0.5
                                    ? 'var(--warning)'
                                    : 'var(--text-muted)',
                          }}
                        >
                          {value.toFixed(2)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-subtle" style={{ marginTop: 10 }}>
              Negative values (shown in green) are where the diversification benefit comes from —
              equity and gold at −0.10 means gold tends to hold up when equity falls. Values above
              0.5 (amber) mean those two assets largely move together, so holding both adds less
              protection than it appears to.
            </p>
          </div>
        </details>
      </Card>

      <Card
        title="What the assistant knows"
        subtitle={`${knowledge.length} reference notes the agent retrieves from when explaining a recommendation`}
      >
        <div className="row-wrap">
          {knowledge.map((doc) => (
            <Badge key={doc.id}>{doc.title}</Badge>
          ))}
          {knowledge.length === 0 && (
            <span className="text-sm text-subtle">Knowledge base unavailable.</span>
          )}
        </div>
        <p className="text-xs text-subtle" style={{ marginTop: 12 }}>
          Retrieval is lexical (BM25) over this small, curated corpus rather than an embedding
          index. At this size an embedding store would add a network hop, a cold-start cost and an
          availability dependency in exchange for no measurable gain — and lexical search works
          identically when the platform runs with no model credentials at all.
        </p>
      </Card>

      <Card title="What is deliberately not modelled" subtitle="Stated plainly, because an unstated omission is a misleading result">
        <div className="grid grid-2" style={{ gap: 10 }}>
          {[
            ['Taxes', 'No capital gains, dividend or income tax is applied to any projection. Real after-tax outcomes are lower.'],
            ['Transaction costs', 'Brokerage, exit loads, bid-ask spreads and rebalancing costs are all excluded.'],
            ['Fat tails', 'Returns are drawn from a log-normal distribution. Real markets crash harder and more often than that implies.'],
            ['Return autocorrelation', 'Each month is drawn independently. Real markets trend and mean-revert.'],
            ['Sequencing within retirement', 'The drawdown uses a fixed real return rather than a simulated path.'],
            ['Life events', 'Illness, divorce, inheritance, business failure and property purchase are not modelled.'],
            ['Your actual products', 'Fund-specific performance, lock-ins, surrender charges and guarantees are not represented.'],
            ['Behaviour', 'The projections assume you keep contributing through every drawdown. Most people do not.'],
          ].map(([title, detail]) => (
            <div key={title}>
              <div className="text-sm strong">{title}</div>
              <div className="text-xs text-muted">{detail}</div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
