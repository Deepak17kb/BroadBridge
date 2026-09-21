import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ASSET_LABELS,
  formatCompact,
  formatCurrency,
  formatPercent,
  type ActionImpact,
  type NextBestAction,
} from '@wealth/shared';
import { api } from '../lib/api';
import { useLoadedProfile } from '../state/ProfileContext';
import {
  AnimatedNumber,
  AssumptionList,
  Badge,
  Callout,
  Card,
  ProgressBar,
  ScoreRing,
  Stat,
} from '../components/ui';
import { ImpactHero } from '../components/ImpactHero';
import {
  AllocationBar,
  AllocationLegend,
  ExpenseBars,
  GoalFundingChart,
  PillarMeters,
  TableToggle,
} from '../components/charts/Charts';

/**
 * The dashboard.
 *
 * Ordered by what a user needs to know rather than by what is easy to show:
 * one headline score, then the balance sheet, then whether the goals are
 * actually going to happen, then the single most important thing to do next.
 *
 * Everything on this page is derived from the profile by the shared engine, so
 * there is no separate dashboard dataset that could drift out of date.
 */
export function Dashboard() {
  const { profile, snapshot } = useLoadedProfile();
  const { currency } = profile;
  const { cashflow, netWorth, portfolio, retirement, wellness, risk, goalProjections } = snapshot;

  const onTrack = goalProjections.filter((g) => g.onTrack).length;
  const money = (v: number) => formatCompact(v, currency);
  // The dashboard is a summary surface: three is enough to act on, and the
  // full ranked list lives one click away on /actions.
  const topActions: NextBestAction[] = snapshot.actions.slice(0, 3);
  const firstName = profile.displayName.split(' ')[0] || 'there';

  /*
   * The impact figure is computed server-side rather than in the browser: it
   * runs three cumulative snapshots and three seeded 1,500-path simulations,
   * which is real work to do on the render thread every time a slider moves
   * somewhere else in the app. It refetches when the profile is saved, so
   * applying an action updates the headline it came from.
   */
  const [impact, setImpact] = useState<ActionImpact | null>(null);
  const [impactLoading, setImpactLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setImpactLoading(true);
    api
      .impact(profile.id, 3)
      .then((r) => !cancelled && setImpact(r))
      .catch(() => !cancelled && setImpact(null))
      .finally(() => !cancelled && setImpactLoading(false));
    return () => {
      cancelled = true;
    };
  }, [profile.id, profile.updatedAt]);

  return (
    <div className="stack">
      <header className="page-head">
        <div className="row-between">
          <div>
            <h1>
              {greeting()}, {firstName}
            </h1>
            <p>
              {wellness.grade === 'A'
                ? 'Your plan is in good shape. The detail below shows where the remaining slack is.'
                : wellness.grade === 'B'
                  ? 'A solid position with a few specific gaps worth closing.'
                  : wellness.grade === 'C'
                    ? 'The foundations need attention before the investing side will matter much.'
                    : 'There are some urgent gaps here. Start at the top of the action list.'}
            </p>
          </div>
          <Link to="/assistant" className="btn btn-primary">
            Ask the assistant
          </Link>
        </div>
      </header>

      {/* What the advice is worth, before the advice itself. */}
      <ImpactHero impact={impact} currency={currency} loading={impactLoading} />

      {/* Headline: one score, its drivers, and the immediate next step. */}
      <div className="grid grid-sidebar">
        <Card
          title="Financial wellness"
          subtitle={
            wellness.dataComplete
              ? 'Five weighted pillars, each shown with its own arithmetic'
              : 'Based on partial information — some pillars could not be scored'
          }
        >
          <div className="wellness-summary">
            <div className="stack-sm">
              <ScoreRing score={wellness.total} grade={wellness.dataComplete ? wellness.grade : undefined} />
              {wellness.dataComplete ? (
                <Badge tone={wellness.total >= 65 ? 'positive' : wellness.total >= 45 ? 'warning' : 'negative'}>
                  {wellness.total >= 80
                    ? 'Strong'
                    : wellness.total >= 65
                      ? 'Healthy'
                      : wellness.total >= 45
                        ? 'Needs work'
                        : 'At risk'}
                </Badge>
              ) : (
                /* A confident grade on absent data is worse than no grade. */
                <Badge tone="warning">Incomplete</Badge>
              )}
            </div>
            <div className="wellness-pillars">
              <PillarMeters wellness={wellness} />
            </div>
          </div>
          {!wellness.dataComplete && (
            <Callout tone="info">
              This score is provisional. Add {wellness.missing.join(', ')} and it will reflect your
              real position — <Link to="/profile">complete your details</Link>.
            </Callout>
          )}
        </Card>

        <Card
          title="Do this next"
          subtitle="The three highest-impact moves for the effort they take"
          actions={
            <Link to="/actions" className="btn btn-sm">
              See all {snapshot.actions.length} actions
            </Link>
          }
        >
          {topActions.length > 0 ? (
            <div className="stack-sm">
              {topActions.map((action, i) => (
                <div key={action.id} className="stack-sm">
                  {i > 0 && <div className="divider" />}
                  <div className="strong">{action.title}</div>
                  <p className="text-sm text-muted">{action.why}</p>
                  <div className="row-between">
                    <Badge tone={i === 0 ? 'accent' : 'info'}>{action.category}</Badge>
                    <span className="text-sm">
                      <span className="text-positive strong num">
                        {action.impact.unit === 'currency'
                          ? formatCompact(action.impact.value, currency)
                          : action.impact.unit === 'percent'
                            ? `${action.impact.value}%`
                            : `${action.impact.value} ${action.impact.unit}`}
                      </span>{' '}
                      <span className="text-xs text-subtle">{action.impact.metric.toLowerCase()}</span>
                    </span>
                  </div>
                </div>
              ))}
              <div className="divider" />
              <div className="text-xs text-subtle">
                {snapshot.actions.length} actions identified ·{' '}
                {snapshot.actions.filter((a) => a.effort === 'low').length} are low-effort
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted">
              Nothing pressing - your plan is on track on every check the engine runs.
            </p>
          )}
        </Card>
      </div>

      {/* Balance sheet and cashflow. Stat tiles, because these are single
          current values - a bar chart of four unrelated numbers says nothing. */}
      <div className="grid grid-4">
        <Card>
          <Stat
            label="Net worth"
            value={<AnimatedNumber value={netWorth.netWorth} format={money} />}
            meta={`${formatCompact(netWorth.assets, currency)} assets − ${formatCompact(netWorth.liabilities, currency)} debt`}
            tone={netWorth.netWorth >= 0 ? 'neutral' : 'negative'}
          />
        </Card>
        <Card>
          <Stat
            label="Monthly surplus"
            value={<AnimatedNumber value={cashflow.monthlySurplus} format={money} />}
            meta={
              cashflow.monthlySurplus >= 0
                ? `Saving ${formatPercent(cashflow.savingsRatePct, 0)} of income`
                : 'Commitments exceed income'
            }
            tone={cashflow.monthlySurplus >= 0 ? 'positive' : 'negative'}
          />
        </Card>
        <Card>
          <Stat
            label="Emergency cover"
            value={<AnimatedNumber value={cashflow.emergencyFundMonths} format={(v) => `${v.toFixed(1)} mo`} />}
            meta={
              cashflow.emergencyFundGap > 0
                ? `${formatCompact(cashflow.emergencyFundGap, currency)} short of ${snapshot.assumptions.emergencyFundMonths} months`
                : 'Fully funded'
            }
            tone={
              cashflow.emergencyFundMonths >= snapshot.assumptions.emergencyFundMonths
                ? 'positive'
                : cashflow.emergencyFundMonths >= 3
                  ? 'warning'
                  : 'negative'
            }
          />
        </Card>
        <Card>
          <Stat
            label="Retirement funded"
            value={<AnimatedNumber value={retirement.readinessRatio} format={(v) => formatPercent(v, 0)} />}
            meta={`${formatCompact(retirement.projectedCorpus, currency)} of ${formatCompact(retirement.corpusRequired, currency)} needed`}
            tone={
              retirement.readinessRatio >= 0.9
                ? 'positive'
                : retirement.readinessRatio >= 0.6
                  ? 'warning'
                  : 'negative'
            }
          />
        </Card>
      </div>

      {retirement.depletionAge && (
        <Callout tone="warning">
          On your current plan the retirement corpus would run out around age{' '}
          <strong>{retirement.depletionAge}</strong>. Closing the gap needs{' '}
          <strong>{formatCompact(retirement.monthlyGap, currency)}</strong> more a month, a later
          retirement date, or a lower target spend —{' '}
          <Link to="/scenarios">test each option in the Scenario Lab</Link>.
        </Callout>
      )}

      {/* Goals: are these actually going to happen? */}
      <Card
        title="Goal funding"
        subtitle={`${onTrack} of ${goalProjections.length} fully funded on current behaviour. Targets are shown in the money of the year you need them, not today's.`}
        actions={
          <Link to="/goals" className="btn btn-sm">
            Manage goals
          </Link>
        }
      >
        {goalProjections.length === 0 ? (
          <p className="text-sm text-muted">
            No goals set yet. <Link to="/goals">Add one</Link> and the engine will project it.
          </p>
        ) : (
          <>
            <GoalFundingChart projections={goalProjections} currency={currency} />
            <TableToggle>
              <table className="data">
                <thead>
                  <tr>
                    <th>Goal</th>
                    <th className="right">Years away</th>
                    <th className="right">Needed then</th>
                    <th className="right">Projected</th>
                    <th className="right">Funded</th>
                    <th className="right">Needs / month</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {goalProjections.map((g) => (
                    <tr key={g.goalId}>
                      <td>{g.goalName}</td>
                      <td className="right num">{g.yearsToGoal.toFixed(1)}</td>
                      <td className="right num">{formatCompact(g.inflatedTarget, currency)}</td>
                      <td className="right num">{formatCompact(g.projectedCorpus, currency)}</td>
                      <td className="right num">{formatPercent(g.fundedRatio, 0)}</td>
                      <td className="right num">{formatCompact(g.requiredMonthly, currency)}</td>
                      <td>
                        <Badge tone={g.onTrack ? 'positive' : 'negative'}>
                          {g.onTrack ? 'On track' : `Short by ${formatCompact(Math.abs(g.surplus), currency)}`}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableToggle>
          </>
        )}
      </Card>

      <div className="grid grid-2">
        <Card
          title="Where your money goes"
          subtitle={`${formatCurrency(cashflow.monthlyExpenses, currency)} a month across ${cashflow.expenseBreakdown.length} categories`}
        >
          <ExpenseBars breakdown={cashflow.expenseBreakdown} currency={currency} />
          {cashflow.totalEmi > 0 && (
            <p className="text-xs text-subtle">
              Plus {formatCompact(cashflow.totalEmi, currency)} of loan EMIs, which is{' '}
              {formatPercent(cashflow.debtToIncomeRatio, 0)} of your income. Lenders start to worry past
              40%.
            </p>
          )}
        </Card>

        <Card
          title="How you are invested"
          subtitle={`${formatCompact(portfolio.totalValue, currency)} across ${profile.holdings.length} holdings, versus the ${risk.bucket} target mix`}
          actions={
            <Link to="/portfolio" className="btn btn-sm">
              Details
            </Link>
          }
        >
          <div className="stack-sm">
            <AllocationBar
              weights={portfolio.weights}
              label="What you hold today"
              total={portfolio.totalValue}
              currency={currency}
            />
            <AllocationBar
              weights={snapshot.recommendedAllocation}
              label={`Recommended for ${risk.bucket}`}
              total={portfolio.totalValue}
              currency={currency}
            />
            <AllocationLegend weights={portfolio.weights} />
          </div>

          <div className="grid grid-3">
            <Stat
              label="Expected return"
              value={formatPercent(portfolio.expectedReturnPct)}
              meta="per year, long run"
            />
            <Stat
              label="Volatility"
              value={formatPercent(portfolio.volatilityPct)}
              meta="typical yearly swing"
            />
            <Stat
              label="Out of position"
              value={`${portfolio.totalDriftPct}%`}
              meta={
                portfolio.totalDriftPct > 10
                  ? 'Share of the portfolio worth moving'
                  : 'Within tolerance'
              }
              tone={portfolio.totalDriftPct > 10 ? 'warning' : 'neutral'}
            />
          </div>

          <TableToggle label="Allocation as a table">
            <table className="data">
              <thead>
                <tr>
                  <th>Asset class</th>
                  <th className="right">You hold</th>
                  <th className="right">Target</th>
                  <th className="right">Difference</th>
                  <th className="right">Value</th>
                </tr>
              </thead>
              <tbody>
                {portfolio.drift.map((d) => (
                  <tr key={d.assetClass}>
                    <td>{ASSET_LABELS[d.assetClass]}</td>
                    <td className="right num">{formatPercent(d.current, 1)}</td>
                    <td className="right num">{formatPercent(d.target, 1)}</td>
                    <td className={`right num ${d.deltaPct > 0 ? 'text-warning' : d.deltaPct < 0 ? 'text-muted' : ''}`}>
                      {d.deltaPct > 0 ? '+' : ''}
                      {(d.deltaPct * 100).toFixed(1)} pt
                    </td>
                    <td className="right num">
                      {formatCompact(d.current * portfolio.totalValue, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableToggle>
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Your risk profile" subtitle="Willingness and ability, assessed separately">
          <div className="stack-sm">
            <div className="row-between">
              <span className="text-sm">Willingness to take risk</span>
              <span className="text-sm num strong">{risk.toleranceScore}/100</span>
            </div>
            <ProgressBar value={risk.toleranceScore / 100} tone="positive" label="Risk tolerance" />
          </div>
          <div className="stack-sm">
            <div className="row-between">
              <span className="text-sm">Ability to absorb a loss</span>
              <span className="text-sm num strong">{risk.capacityScore}/100</span>
            </div>
            <ProgressBar value={risk.capacityScore / 100} tone="warning" label="Risk capacity" />
          </div>
          <div className="stack-sm">
            <div className="row-between">
              <span className="text-sm strong">Plan uses</span>
              <Badge tone="accent">{risk.bucket}</Badge>
            </div>
            <p className="text-xs text-muted">
              The plan follows the lower of the two. A portfolio you abandon halfway through a
              drawdown is worse than a cautious one you keep.
            </p>
          </div>
          <hr className="divider" />
          <ul className="bullets text-xs text-subtle">
            {risk.drivers.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
          <div>
            <Link to="/profile" className="btn btn-sm">
              Retake the questionnaire
            </Link>
          </div>
        </Card>

        <Card title="Retirement outlook" subtitle="Sized from the spending you would need to replace">
          <div className="grid grid-4">
            <Stat
              label="Years to retirement"
              value={retirement.yearsToRetirement}
              meta={`Retiring at ${profile.retirementAge}`}
            />
            <Stat
              label="Annual spend then"
              value={formatCompact(retirement.targetAnnualSpend, currency)}
              meta="Today's expenses, inflated"
            />
            <Stat
              label="Corpus required"
              value={formatCompact(retirement.corpusRequired, currency)}
              meta={`At a ${formatPercent(snapshot.assumptions.safeWithdrawalRatePct, 1)} withdrawal rate`}
            />
            <Stat
              label="Projected corpus"
              value={formatCompact(retirement.projectedCorpus, currency)}
              meta={retirement.monthlyGap > 0 ? `${formatCompact(retirement.monthlyGap, currency)}/mo short` : 'On track'}
              tone={retirement.readinessRatio >= 0.9 ? 'positive' : 'warning'}
            />
          </div>
          <div className="stack-sm">
            <ProgressBar value={retirement.readinessRatio} label="Retirement readiness" />
            <div className="text-xs text-subtle">
              {formatPercent(retirement.readinessRatio, 0)} of the required corpus on current behaviour
            </div>
          </div>
          <AssumptionList assumptions={retirement.assumptions} title="How this was calculated" />
        </Card>
      </div>

      <Card title="Platform assumptions" subtitle="Every projection on this page rests on these, and you can change them">
        <div className="grid grid-4">
          <Stat label="Inflation" value={formatPercent(snapshot.assumptions.inflationPct)} meta="per year" />
          <Stat label="Risk-free rate" value={formatPercent(snapshot.assumptions.riskFreePct)} meta="for Sharpe ratio" />
          <Stat
            label="Equity return"
            value={formatPercent(snapshot.assumptions.expectedReturns.equity_domestic)}
            meta="long-run planning figure"
          />
          <Stat
            label="Withdrawal rate"
            value={formatPercent(snapshot.assumptions.safeWithdrawalRatePct, 1)}
            meta="sustainable in retirement"
          />
        </div>
        <div className="row-wrap">
          <Link to="/assumptions" className="btn btn-sm">
            Review and edit assumptions
          </Link>
          <span className="text-xs text-subtle">
            These are long-run planning assumptions, not forecasts. Change them and every number on
            the platform updates.
          </span>
        </div>
      </Card>
    </div>
  );
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
