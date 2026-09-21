import { useMemo, useState } from 'react';
import {
  formatCompact,
  formatPercent,
  projectGoal,
  resolveAssumptions,
  returnForGoal,
  runMonteCarlo,
  portfolioExpectedReturn,
  portfolioVolatility,
  recommendAllocation,
  yearsToGoal,
  applyActionMutation,
  optimiseGoalFunding,
  type Goal,
} from '@wealth/shared';
import { useLoadedProfile, useProfile } from '../state/ProfileContext';
import { AssumptionList, Badge, Callout, Card, Empty, MoneyInput, ProgressBar, Slider, Stat } from '../components/ui';
import { GoalFundingChart, MonteCarloFan, TableToggle } from '../components/charts/Charts';
import { SurplusSplit } from '../components/SurplusSplit';

/**
 * Goal planning.
 *
 * The detail panel is a live model: adjust the contribution or the target year
 * and the projection, the funding gap and the simulated success probability all
 * move as you drag. The "test" sliders deliberately do *not* save - a user
 * exploring what a change would do should not have their plan quietly rewritten
 * underneath them. Committing is a separate, explicit button.
 */
export function Goals() {
  const { profile, snapshot } = useLoadedProfile();
  const { updateProfile } = useProfile();
  const { currency } = profile;

  const [selectedId, setSelectedId] = useState<string | null>(profile.goals[0]?.id ?? null);
  const [splitApplied, setSplitApplied] = useState(false);
  const [testExtra, setTestExtra] = useState(0);
  const [testLump, setTestLump] = useState(0);

  const selected = profile.goals.find((g) => g.id === selectedId) ?? null;
  const assumptions = resolveAssumptions(profile);

  /*
   * Run in the browser like every other projection on this page: it is the same
   * engine the endpoint calls, so the split shown here and the one the agent
   * quotes are the same numbers, and the user sees it move as they edit a goal.
   */
  const split = useMemo(
    () => optimiseGoalFunding({ profile, snapshot }),
    [profile, snapshot],
  );

  /** Rewrites every contribution to the optimiser's split, through the shared applier. */
  function applySplit() {
    updateProfile((draft) => {
      applyActionMutation(
        draft,
        {
          type: 'set_goal_contributions',
          allocations: split.allocations.map((a) => ({ goalId: a.goalId, monthly: a.allocated })),
        },
        { recommendedAllocation: snapshot.recommendedAllocation },
      );
    });
    setSplitApplied(true);
  }

  const projection = useMemo(() => {
    if (!selected) return null;
    return projectGoal(selected, {
      annualReturn: returnForGoal(selected, profile, assumptions),
      assumptions,
      extraMonthly: testExtra,
      lumpSum: testLump,
    });
  }, [selected, profile, assumptions, testExtra, testLump]);

  /** The goal's own horizon drives its allocation, so its simulation uses that mix. */
  const simulation = useMemo(() => {
    if (!selected || !projection) return null;
    const years = Math.max(1, Math.ceil(projection.yearsToGoal));
    const allocation = recommendAllocation(snapshot.risk.bucket, projection.yearsToGoal);
    return runMonteCarlo({
      startingCorpus: selected.currentSaved + testLump,
      monthlyContribution: selected.monthlyContribution + testExtra,
      contributionStepUpPct: selected.contributionStepUpPct,
      years,
      expectedReturnPct: portfolioExpectedReturn(allocation, assumptions),
      volatilityPct: portfolioVolatility(allocation, assumptions),
      target: projection.inflatedTarget,
      paths: 1500,
    });
  }, [selected, projection, snapshot.risk.bucket, assumptions, testExtra, testLump]);

  const onTrack = snapshot.goalProjections.filter((g) => g.onTrack).length;
  const monthlyCommitted = profile.goals.reduce((acc, g) => acc + g.monthlyContribution, 0);

  function addGoal() {
    const id = `g-${Date.now()}`;
    updateProfile((draft) =>
      draft.goals.push({
        id,
        name: 'New goal',
        kind: 'custom',
        targetAmountToday: 1000000,
        targetYear: new Date().getUTCFullYear() + 10,
        currentSaved: 0,
        monthlyContribution: 5000,
        contributionStepUpPct: 0,
        priority: 'important',
      }),
    );
    setSelectedId(id);
  }

  function editSelected(mutate: (goal: Goal) => void) {
    if (!selected) return;
    updateProfile((draft) => {
      const goal = draft.goals.find((g) => g.id === selected.id);
      if (goal) mutate(goal);
    });
  }

  return (
    <div className="stack">
      <header className="page-head">
        <div className="row-between">
          <div>
            <h1>Goals</h1>
            <p>
              Targets are stated in today's money and inflated to the year you need them, and each
              goal is projected at the return of a portfolio suited to <em>its own</em> horizon — not
              one blended rate across everything.
            </p>
          </div>
          <button className="btn btn-primary" onClick={addGoal}>
            + Add goal
          </button>
        </div>
      </header>

      {/* The competition between goals, before the per-goal detail that hides it. */}
      {profile.goals.length > 1 && (
        <SurplusSplit
          result={split}
          currency={currency}
          onApply={applySplit}
          applied={splitApplied}
        />
      )}

      {profile.goals.length === 0 ? (
        <Card>
          <Empty
            title="No goals yet"
            message="Add what you are actually saving for. Named goals get funded far more reliably than a general investment pot."
            action={
              <button className="btn btn-primary" onClick={addGoal}>
                Add your first goal
              </button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-4">
            <Card>
              <Stat
                label="Goals on track"
                value={`${onTrack} / ${profile.goals.length}`}
                tone={onTrack === profile.goals.length ? 'positive' : 'warning'}
                meta="fully funded on current behaviour"
              />
            </Card>
            <Card>
              <Stat
                label="Committed monthly"
                value={formatCompact(monthlyCommitted, currency)}
                meta={`${formatPercent(monthlyCommitted / (snapshot.cashflow.monthlyIncome || 1), 0)} of income`}
              />
            </Card>
            <Card>
              <Stat
                label="Total shortfall"
                value={formatCompact(
                  snapshot.goalProjections.reduce((acc, g) => acc + Math.max(0, -g.surplus), 0),
                  currency,
                )}
                meta="summed across every goal"
                tone="negative"
              />
            </Card>
            <Card>
              <Stat
                label="To fully fund everything"
                value={formatCompact(
                  snapshot.goalProjections.reduce((acc, g) => acc + g.monthlyGap, 0),
                  currency,
                )}
                meta="extra per month"
                tone="warning"
              />
            </Card>
          </div>

          <Card title="All goals" subtitle="Needed at the goal date versus what your plan projects">
            <GoalFundingChart projections={snapshot.goalProjections} currency={currency} />
          </Card>

          <div className="grid grid-sidebar-left">
            {/* Goal list. */}
            <Card title="Your goals" subtitle="Select one to model it">
              <div className="stack-sm">
                {snapshot.goalProjections.map((p) => {
                  const goal = profile.goals.find((g) => g.id === p.goalId);
                  const active = selectedId === p.goalId;
                  return (
                    <button
                      key={p.goalId}
                      className={`persona ${active ? 'selected' : ''}`}
                      style={{ padding: 12 }}
                      onClick={() => {
                        setSelectedId(p.goalId);
                        setTestExtra(0);
                        setTestLump(0);
                      }}
                    >
                      <div className="row-between">
                        <span className="text-sm strong">{p.goalName}</span>
                        <Badge tone={p.onTrack ? 'positive' : 'negative'}>
                          {formatPercent(p.fundedRatio, 0)}
                        </Badge>
                      </div>
                      <div style={{ margin: '7px 0' }}>
                        <ProgressBar value={p.fundedRatio} label={`${p.goalName} funding`} />
                      </div>
                      <div className="text-xs text-subtle">
                        {formatCompact(p.inflatedTarget, currency)} needed in {p.yearsToGoal.toFixed(1)}y ·{' '}
                        {formatCompact(goal?.monthlyContribution ?? 0, currency)}/mo
                        {goal?.priority === 'must_have' && ' · must have'}
                      </div>
                    </button>
                  );
                })}
              </div>
            </Card>

            {/* Detail and live model. */}
            {selected && projection ? (
              <div className="stack">
                <Card
                  title={selected.name}
                  subtitle={`${projection.yearsToGoal.toFixed(1)} years away · projected at ${formatPercent(projection.assumedReturnPct)} a year`}
                  actions={
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => {
                        updateProfile((d) => {
                          d.goals = d.goals.filter((g) => g.id !== selected.id);
                        });
                        setSelectedId(profile.goals.find((g) => g.id !== selected.id)?.id ?? null);
                      }}
                    >
                      Delete goal
                    </button>
                  }
                >
                  <div className="grid grid-4" style={{ gap: 14 }}>
                    <Stat
                      label="Needed at goal date"
                      value={formatCompact(projection.inflatedTarget, currency)}
                      meta={`${formatCompact(selected.targetAmountToday, currency)} in today's money`}
                    />
                    <Stat
                      label="Projected"
                      value={formatCompact(projection.projectedCorpus, currency)}
                      tone={projection.onTrack ? 'positive' : 'negative'}
                      meta={formatPercent(projection.fundedRatio, 0) + ' funded'}
                    />
                    <Stat
                      label={projection.surplus >= 0 ? 'Surplus' : 'Shortfall'}
                      value={formatCompact(Math.abs(projection.surplus), currency)}
                      tone={projection.surplus >= 0 ? 'positive' : 'negative'}
                    />
                    <Stat
                      label="Needs per month"
                      value={formatCompact(projection.requiredMonthly, currency)}
                      meta={
                        projection.monthlyGap > 0
                          ? `${formatCompact(projection.monthlyGap, currency)} more than now`
                          : 'Current contribution is enough'
                      }
                      tone={projection.monthlyGap > 0 ? 'warning' : 'positive'}
                    />
                  </div>

                  {!projection.onTrack && (
                    <div style={{ marginTop: 14 }}>
                      <Callout tone="warning">
                        {projection.requiredReturnPct === null ? (
                          <>
                            No realistic return closes this gap — it needs a bigger contribution, more
                            time, or a smaller target.
                          </>
                        ) : (
                          <>
                            The alternative to saving more is earning{' '}
                            <strong>{formatPercent(projection.requiredReturnPct)}</strong> a year
                            instead of the <strong>{formatPercent(projection.assumedReturnPct)}</strong>{' '}
                            assumed. A return is not something you can choose, so treat that as a
                            measure of how large the gap is rather than a plan.
                          </>
                        )}
                      </Callout>
                    </div>
                  )}
                </Card>

                <Card
                  title="Test a change"
                  subtitle="Nothing is saved until you commit it — drag freely"
                >
                  <div className="stack">
                    <Slider
                      label="Extra each month"
                      value={testExtra}
                      min={0}
                      max={Math.max(20000, Math.round(projection.requiredMonthly * 1.5))}
                      step={500}
                      onChange={setTestExtra}
                      format={(v) => (v ? `+${formatCompact(v, currency)}` : 'No change')}
                    />
                    <Slider
                      label="One-off lump sum"
                      value={testLump}
                      min={0}
                      max={Math.max(500000, Math.round(selected.targetAmountToday * 0.5))}
                      step={25000}
                      onChange={setTestLump}
                      format={(v) => (v ? formatCompact(v, currency) : 'None')}
                    />

                    {(testExtra > 0 || testLump > 0) && (
                      <>
                        <Callout tone={projection.onTrack ? 'positive' : 'info'}>
                          With this change the goal reaches{' '}
                          <strong>{formatCompact(projection.projectedCorpus, currency)}</strong> —{' '}
                          {projection.onTrack ? (
                            <span className="text-positive">fully funded</span>
                          ) : (
                            <>
                              still <strong>{formatCompact(Math.abs(projection.surplus), currency)}</strong>{' '}
                              short
                            </>
                          )}
                          {simulation && (
                            <>
                              , with <strong>{formatPercent(simulation.successProbability, 0)}</strong> of
                              simulated market paths reaching the target
                            </>
                          )}
                          .
                        </Callout>
                        <div className="row-wrap">
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => {
                              editSelected((g) => {
                                g.monthlyContribution += testExtra;
                                g.currentSaved += testLump;
                              });
                              setTestExtra(0);
                              setTestLump(0);
                            }}
                          >
                            Commit this to my plan
                          </button>
                          <button
                            className="btn btn-sm btn-ghost"
                            onClick={() => {
                              setTestExtra(0);
                              setTestLump(0);
                            }}
                          >
                            Discard
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </Card>

                {simulation && (
                  <Card
                    title="Range of outcomes for this goal"
                    subtitle={`${formatPercent(simulation.successProbability, 0)} of ${simulation.paths.toLocaleString('en-US')} simulated paths reach the target`}
                  >
                    <MonteCarloFan result={simulation} currency={currency} height={215} />
                  </Card>
                )}

                <Card title="Edit this goal" subtitle="Changes here save automatically">
                  <div className="grid grid-2">
                    <div className="field">
                      <label htmlFor="goal-name">Name</label>
                      <input
                        id="goal-name"
                        className="input"
                        value={selected.name}
                        onChange={(e) => editSelected((g) => void (g.name = e.target.value))}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="goal-kind">Type</label>
                      <select
                        id="goal-kind"
                        className="select"
                        value={selected.kind}
                        onChange={(e) => editSelected((g) => void (g.kind = e.target.value as Goal['kind']))}
                      >
                        <option value="retirement">Retirement</option>
                        <option value="education">Education</option>
                        <option value="home">Home</option>
                        <option value="vehicle">Vehicle</option>
                        <option value="travel">Travel</option>
                        <option value="emergency">Emergency fund</option>
                        <option value="wealth">Wealth building</option>
                        <option value="custom">Other</option>
                      </select>
                    </div>
                    <MoneyInput
                      label="Cost in today's money"
                      value={selected.targetAmountToday}
                      currency={currency}
                      step={50000}
                      onChange={(v) => editSelected((g) => void (g.targetAmountToday = v))}
                    />
                    <div className="field">
                      <label htmlFor="goal-year">Target year</label>
                      <input
                        id="goal-year"
                        className="input num"
                        type="number"
                        min={new Date().getUTCFullYear()}
                        max={2120}
                        value={selected.targetYear}
                        onChange={(e) =>
                          editSelected((g) => void (g.targetYear = Number(e.target.value) || g.targetYear))
                        }
                      />
                      <div className="field-hint">
                        {yearsToGoal(selected.targetYear).toFixed(1)} years from today
                      </div>
                    </div>
                    <MoneyInput
                      label="Already saved"
                      value={selected.currentSaved}
                      currency={currency}
                      step={10000}
                      onChange={(v) => editSelected((g) => void (g.currentSaved = v))}
                    />
                    <MoneyInput
                      label="Saving each month"
                      value={selected.monthlyContribution}
                      currency={currency}
                      step={1000}
                      onChange={(v) => editSelected((g) => void (g.monthlyContribution = v))}
                    />
                    <div className="field">
                      <label htmlFor="goal-stepup">Annual step-up (%)</label>
                      <input
                        id="goal-stepup"
                        className="input num"
                        type="number"
                        min={0}
                        max={50}
                        value={Math.round(selected.contributionStepUpPct * 100)}
                        onChange={(e) =>
                          editSelected(
                            (g) => void (g.contributionStepUpPct = (Number(e.target.value) || 0) / 100),
                          )
                        }
                      />
                      <div className="field-hint">
                        Raising contributions with your salary is the single largest lever available
                      </div>
                    </div>
                    <div className="field">
                      <label htmlFor="goal-priority">Priority</label>
                      <select
                        id="goal-priority"
                        className="select"
                        value={selected.priority}
                        onChange={(e) =>
                          editSelected((g) => void (g.priority = e.target.value as Goal['priority']))
                        }
                      >
                        <option value="must_have">Must have</option>
                        <option value="important">Important</option>
                        <option value="aspirational">Nice to have</option>
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="goal-inflation">Goal-specific inflation (%)</label>
                      <input
                        id="goal-inflation"
                        className="input num"
                        type="number"
                        min={0}
                        max={30}
                        step={0.5}
                        value={((selected.inflationOverridePct ?? assumptions.inflationPct) * 100).toFixed(1)}
                        onChange={(e) =>
                          editSelected(
                            (g) => void (g.inflationOverridePct = (Number(e.target.value) || 0) / 100),
                          )
                        }
                      />
                      <div className="field-hint">
                        Education and healthcare historically inflate several points above headline
                      </div>
                    </div>
                  </div>
                </Card>

                <AssumptionList
                  assumptions={projection.assumptions}
                  title="How this projection was calculated"
                  open
                />
              </div>
            ) : (
              <Card>
                <Empty title="Select a goal" message="Choose a goal on the left to model it in detail." />
              </Card>
            )}
          </div>

          <Card title="All goals as a table" subtitle="Every projected figure, exactly">
            <TableToggle label="Show table">
              <table className="data">
                <thead>
                  <tr>
                    <th>Goal</th>
                    <th className="right">Today's cost</th>
                    <th className="right">Needed then</th>
                    <th className="right">Projected</th>
                    <th className="right">Gap</th>
                    <th className="right">Saving now</th>
                    <th className="right">Needs</th>
                    <th className="right">Return used</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.goalProjections.map((p) => {
                    const goal = profile.goals.find((g) => g.id === p.goalId);
                    return (
                      <tr key={p.goalId}>
                        <td>{p.goalName}</td>
                        <td className="right num">{formatCompact(goal?.targetAmountToday ?? 0, currency)}</td>
                        <td className="right num">{formatCompact(p.inflatedTarget, currency)}</td>
                        <td className="right num">{formatCompact(p.projectedCorpus, currency)}</td>
                        <td className={`right num ${p.surplus < 0 ? 'text-negative' : 'text-positive'}`}>
                          {p.surplus >= 0 ? '+' : '-'}
                          {formatCompact(Math.abs(p.surplus), currency)}
                        </td>
                        <td className="right num">{formatCompact(goal?.monthlyContribution ?? 0, currency)}</td>
                        <td className="right num">{formatCompact(p.requiredMonthly, currency)}</td>
                        <td className="right num">{formatPercent(p.assumedReturnPct)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableToggle>
          </Card>
        </>
      )}
    </div>
  );
}
