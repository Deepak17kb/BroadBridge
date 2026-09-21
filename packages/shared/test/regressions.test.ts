import { test } from 'node:test';
import assert from 'node:assert/strict';
/**
 * Regression tests for bugs found in a full-platform bug sweep. Each test names
 * the behaviour that was wrong, so a failure here says exactly what came back.
 */
import { PERSONAS, personaById } from '../src/data/personas.js';
import {
  allocationForGoal,
  buildSnapshot,
  returnForGoal,
  resolveAssumptions,
  runScenario,
} from '../src/finance/engine.js';
import { accumulate } from '../src/finance/math.js';
import { runMonteCarlo } from '../src/finance/montecarlo.js';
import { assessRetirement, planDebtPayoff } from '../src/finance/cashflow.js';
import { applyActionMutation } from '../src/finance/mutations.js';
import { holdingValue, portfolioExpectedReturn } from '../src/finance/portfolio.js';
import { computeActionImpact } from '../src/impact.js';
import { formatCompact, formatYears } from '../src/format.js';
import type { Liability, UserProfile } from '../src/types.js';

const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

function persona(id: string): UserProfile {
  const p = personaById(id);
  assert.ok(p, `persona ${id} exists`);
  return structuredClone(p.profile);
}

/** A simulation with negligible volatility, so its median is the deterministic path. */
function flatSimulation(input: Partial<Parameters<typeof runMonteCarlo>[0]>) {
  return runMonteCarlo({
    startingCorpus: 100_000,
    monthlyContribution: 1_000,
    contributionStepUpPct: 0,
    years: 5,
    expectedReturnPct: 0.1,
    volatilityPct: 1e-6,
    target: 0,
    paths: 200,
    ...input,
  });
}

function closeTo(actual: number, expected: number, relTol: number, message: string): void {
  const scale = Math.max(Math.abs(expected), 1);
  assert.ok(
    Math.abs(actual - expected) / scale <= relTol,
    `${message}: got ${actual}, expected about ${expected}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Accumulation and simulation                                                 */
/* -------------------------------------------------------------------------- */

test('a career break that outlasts the shock keeps pausing contributions after it', () => {
  const base = { startingCorpus: 0, monthlyContribution: 1000, annualReturn: 0, years: 5, stepUpPct: 0, skipMonths: 36 };
  // 60 months, the first 36 paused: 24 contributions whether or not a 0% shock lands in year 1.
  assert.equal(accumulate(base), 24_000);
  assert.equal(accumulate({ ...base, shockPct: 0, shockYear: 1 }), 24_000);
});

test('the simulation runs a fractional horizon in months, not rounded up to whole years', () => {
  const years = 1.25;
  const sim = flatSimulation({ years, monthlyContribution: 0 });
  closeTo(sim.median, 100_000 * Math.pow(1.1, years), 0.001, 'median of a 15-month run');
  const last = sim.bands[sim.bands.length - 1];
  assert.ok(last);
  assert.equal(last.year, 1.25, 'the final band sits at the real horizon');
});

test('a shock at the horizon lands in the simulation, as it does in the projection', () => {
  const plain = flatSimulation({ years: 5 });
  const shocked = flatSimulation({ years: 5, shockPct: -0.5, shockYear: 5 });
  closeTo(shocked.median, plain.median * 0.5, 0.001, 'a 50% drop at the horizon halves the final value');

  const deterministic = accumulate({
    startingCorpus: 100_000,
    monthlyContribution: 1_000,
    annualReturn: 0.1,
    years: 5,
    stepUpPct: 0,
    shockPct: -0.3,
    shockYear: 3,
  });
  const simulated = flatSimulation({ years: 5, shockPct: -0.3, shockYear: 3 });
  closeTo(simulated.median, deterministic, 0.001, 'simulation and projection time the shock identically');
});

test('the simulation honours a career break', () => {
  const deterministic = accumulate({
    startingCorpus: 100_000,
    monthlyContribution: 1_000,
    annualReturn: 0.1,
    years: 5,
    stepUpPct: 0,
    skipMonths: 18,
  });
  const simulated = flatSimulation({ years: 5, skipMonths: 18 });
  closeTo(simulated.median, deterministic, 0.001, 'paused months contribute nothing on every path');
});

/* -------------------------------------------------------------------------- */
/* Scenario engine                                                             */
/* -------------------------------------------------------------------------- */

test('"retire 5 years earlier" moves retirement by five years, not ten', () => {
  const profile = persona('meera');
  const result = runScenario({ profile, levers: { retirementAgeDelta: -5 }, paths: 300, now: FIXED_NOW });
  const years = profile.retirementAge - 5 - profile.age;
  assert.equal(result.monteCarlo.bands.length, years, 'the simulation covers the shifted horizon');

  const earlier = structuredClone(profile);
  earlier.retirementAge -= 5;
  const direct = buildSnapshot(earlier, FIXED_NOW).retirement;
  const later = runScenario({ profile, levers: { retirementAgeDelta: 3 }, paths: 300, now: FIXED_NOW });
  assert.equal(later.monteCarlo.bands.length, profile.retirementAge + 3 - profile.age);
  // Same age, same savings - only the glide-path mix can differ, and it cannot
  // account for a factor-of-two gap in the corpus.
  closeTo(result.snapshot.netWorthAtRetirement, direct.projectedCorpus, 0.25, 'corpus at the shifted age');
});

test('a crash with no year is modelled in year 1, the year its label names', () => {
  const profile = persona('rohan');
  const baseline = buildSnapshot(profile, FIXED_NOW);
  const noYear = runScenario({ profile, levers: { marketShockPct: -0.35 }, baseline, paths: 300, now: FIXED_NOW });
  const yearOne = runScenario({
    profile,
    levers: { marketShockPct: -0.35, shockYear: 1 },
    baseline,
    paths: 300,
    now: FIXED_NOW,
  });
  assert.match(noYear.label, /yr 1/);
  assert.ok(noYear.deltaVsBaseline.netWorthAtRetirement < 0, 'the crash costs something');
  assert.equal(noYear.snapshot.netWorthAtRetirement, yearOne.snapshot.netWorthAtRetirement);
  assert.equal(noYear.monteCarlo.successProbability, yearOne.monteCarlo.successProbability);
});

test('a career break moves the simulated success probability, not just the projection', () => {
  const profile = persona('rohan');
  const baseline = buildSnapshot(profile, FIXED_NOW);
  const plain = runScenario({ profile, levers: {}, baseline, paths: 600, now: FIXED_NOW });
  const paused = runScenario({ profile, levers: { careerBreakMonths: 36 }, baseline, paths: 600, now: FIXED_NOW });
  assert.ok(paused.monteCarlo.median < plain.monteCarlo.median, 'fewer contributions, lower median');
});

test('0% inflation is a scenario, not "no change"', () => {
  const profile = persona('meera');
  const result = runScenario({ profile, levers: { inflationPct: 0 }, paths: 300, now: FIXED_NOW });
  assert.match(result.label, /0\.0% inflation/);
  assert.ok(
    result.deltaVsBaseline.retirementReadiness > 0,
    'with no inflation the same corpus funds far more of retirement',
  );
});

test('choosing the recommended mix as the allocation lever changes no goal projection', () => {
  for (const p of PERSONAS) {
    const baseline = buildSnapshot(p.profile, FIXED_NOW);
    const result = runScenario({
      profile: p.profile,
      levers: { allocation: baseline.recommendedAllocation },
      baseline,
      paths: 300,
      now: FIXED_NOW,
    });
    for (const g of result.goalProjections) {
      const before = baseline.goalProjections.find((b) => b.goalId === g.goalId);
      assert.ok(before);
      assert.equal(g.assumedReturnPct, before.assumedReturnPct, `${p.id}: ${g.goalName} return`);
      assert.equal(g.projectedCorpus, before.projectedCorpus, `${p.id}: ${g.goalName} corpus`);
    }
  }
});

test('extra saving is invested once: goals without a retirement goal leave retirement alone', () => {
  const profile = persona('meera');
  profile.goals = profile.goals.filter((g) => g.kind !== 'retirement');
  const baseline = buildSnapshot(profile, FIXED_NOW);
  for (const levers of [{ extraMonthlySavings: 20_000 }, { lumpSum: 500_000 }]) {
    const result = runScenario({ profile, levers, baseline, paths: 300, now: FIXED_NOW });
    assert.equal(
      result.deltaVsBaseline.netWorthAtRetirement,
      0,
      `${JSON.stringify(levers)}: the goals received this money, so retirement cannot also`,
    );
    const goalsBefore = baseline.goalProjections.reduce((acc, g) => acc + g.projectedCorpus, 0);
    const goalsAfter = result.goalProjections.reduce((acc, g) => acc + g.projectedCorpus, 0);
    assert.ok(goalsAfter > goalsBefore, 'and the goals do benefit');
  }
});

test('extra saving goes to retirement in full when there are no goals to split it across', () => {
  const profile = persona('meera');
  profile.goals = [];
  const baseline = buildSnapshot(profile, FIXED_NOW);
  const result = runScenario({ profile, levers: { extraMonthlySavings: 20_000 }, baseline, paths: 300, now: FIXED_NOW });
  assert.ok(result.deltaVsBaseline.netWorthAtRetirement > 0);
});

test('surplus already committed elsewhere is not also counted as habitual saving', () => {
  const profile = persona('rohan');
  const assumptions = resolveAssumptions(profile);
  assert.ok(buildSnapshot(profile, FIXED_NOW).cashflow.monthlySurplus > 10_000, 'precondition: a free surplus');
  const base = assessRetirement({ profile, assumptions, expectedReturnPct: 0.1 });
  const committed = assessRetirement({ profile, assumptions, expectedReturnPct: 0.1, surplusCommitted: 10_000 });
  assert.equal(
    base.plan.monthlyContribution - committed.plan.monthlyContribution,
    5_000,
    'half of the committed surplus leaves the habitual-saving estimate',
  );
});

test('a profile past its retirement age runs out of money after today, not before it', () => {
  const profile = persona('rohan');
  profile.age = 70;
  profile.retirementAge = 60;
  profile.holdings = [];
  profile.liquidSavings = 0;
  profile.goals = [];
  const result = assessRetirement({ profile, assumptions: resolveAssumptions(profile), expectedReturnPct: 0.08 });
  assert.equal(result.depletionAge, 70, 'with nothing saved, the money is gone this year');
});

/* -------------------------------------------------------------------------- */
/* Debt payoff                                                                 */
/* -------------------------------------------------------------------------- */

test("a debt's unneeded EMI in its final month rolls on to the next debt", () => {
  const profile = persona('aarav');
  const debt = (id: string, outstanding: number, emi: number): Liability => ({
    id,
    name: id,
    kind: 'personal_loan',
    outstanding,
    interestRatePct: 0,
    emi,
  });
  profile.liabilities = [debt('small', 100, 5_000), debt('large', 10_000, 100)];
  // Month 1: 100 clears the small debt and 4,900 + 100 go to the large one.
  // Month 2: the remaining 5,000 is cleared by 5,100 of payments.
  for (const strategy of ['snowball', 'avalanche'] as const) {
    const plan = planDebtPayoff(profile, strategy, 0);
    assert.equal(plan.monthsToDebtFree, 2, `${strategy}: no payment is thrown away`);
    assert.ok(plan.clearsEverything);
  }
});

/* -------------------------------------------------------------------------- */
/* Applying actions                                                            */
/* -------------------------------------------------------------------------- */

test('applying a rebalance removes the single-stock concentration it was asked to trim', () => {
  const profile = persona('aarav');
  const snapshot = buildSnapshot(profile, FIXED_NOW);
  assert.ok((snapshot.portfolio.largestSingleSecurity?.weight ?? 0) > 0.15, 'the persona starts concentrated');
  const invested = profile.holdings.reduce((acc, h) => acc + holdingValue(h), 0);

  const draft = structuredClone(profile);
  applyActionMutation(draft, { type: 'rebalance_to_target' }, { recommendedAllocation: snapshot.recommendedAllocation });
  const after = buildSnapshot(draft, FIXED_NOW);

  assert.equal(after.portfolio.largestSingleSecurity, null, 'the stock is folded into a diversified position');
  assert.ok(!after.actions.some((a) => a.id === 'rebalance-portfolio' && /Trim/.test(a.title)));
  closeTo(draft.holdings.reduce((acc, h) => acc + holdingValue(h), 0), invested, 1e-9, 'value is conserved');
});

test('a rebalance keeps the cost basis of what is held, rather than one holding for the class', () => {
  const profile = persona('rohan');
  const snapshot = buildSnapshot(profile, FIXED_NOW);
  const draft = structuredClone(profile);
  applyActionMutation(draft, { type: 'rebalance_to_target' }, { recommendedAllocation: snapshot.recommendedAllocation });
  const gainBefore = profile.holdings.reduce((acc, h) => acc + holdingValue(h) - h.costBasis, 0);
  const gainAfter = draft.holdings.reduce((acc, h) => acc + holdingValue(h) - h.costBasis, 0);
  // Selling realises part of the gain; buying adds at market. The gain still
  // held can only shrink, never grow, from rearranging the same money.
  assert.ok(gainAfter <= gainBefore + 1, `unrealised gain ${gainAfter} cannot exceed ${gainBefore}`);
  assert.ok(gainAfter >= 0);
});

test('applying "put idle cash to work" moves the idle cash into the portfolio', () => {
  const profile = persona('rohan');
  const snapshot = buildSnapshot(profile, FIXED_NOW);
  const action = snapshot.actions.find((a) => a.id === 'deploy-surplus');
  assert.ok(action?.apply, 'rohan has idle cash');
  const idle = action.evidence?.['idle cash'] ?? 0;
  assert.ok(idle > 0);

  const draft = structuredClone(profile);
  applyActionMutation(draft, action.apply, { recommendedAllocation: snapshot.recommendedAllocation });
  closeTo(draft.liquidSavings, snapshot.cashflow.emergencyFundTarget, 1e-6, 'cash drops to the buffer');
  const investedBefore = profile.holdings.reduce((acc, h) => acc + holdingValue(h), 0);
  const investedAfter = draft.holdings.reduce((acc, h) => acc + holdingValue(h), 0);
  closeTo(investedAfter - investedBefore, idle, 1e-6, 'and the same amount is now invested');
  const after = buildSnapshot(draft, FIXED_NOW);
  assert.ok(
    !after.actions.some((a) => a.id === 'deploy-surplus' && (a.evidence?.['idle cash'] ?? 0) > 0),
    'the idle-cash half of the action is done',
  );
});

test('impact: a rebalance cannot move the median through volatility alone', () => {
  for (const p of PERSONAS) {
    const impact = computeActionImpact({ profile: p.profile, topN: 3, now: FIXED_NOW });
    for (const a of impact.applied) {
      if (a.id === 'rebalance-portfolio') {
        assert.equal(
          a.marginal.medianCorpusAtRetirement,
          0,
          `${p.id}: the plan's mix is unchanged by rearranging the holdings`,
        );
      }
    }
  }
});

test("a goal's simulation mix is the mix its projection is priced on", () => {
  const profile = persona('aarav');
  const assumptions = resolveAssumptions(profile);
  const emergency = profile.goals.find((g) => g.kind === 'emergency');
  assert.ok(emergency);
  const mix = allocationForGoal(emergency, profile, FIXED_NOW);
  assert.ok(mix.cash > 0.5, 'emergency money is held mostly in cash');
  assert.equal(portfolioExpectedReturn(mix, assumptions), returnForGoal(emergency, profile, assumptions, FIXED_NOW));
});

test('"work N more years" is the number of years the engine says it takes', () => {
  let checked = 0;
  for (const p of PERSONAS) {
    const snapshot = buildSnapshot(p.profile, FIXED_NOW);
    const action = snapshot.actions.find((a) => a.id === 'close-retirement-gap');
    if (!action) continue;
    checked += 1;
    const assumptions = resolveAssumptions(p.profile);
    const readinessAfter = (extra: number) =>
      assessRetirement({
        profile: p.profile,
        assumptions,
        expectedReturnPct: snapshot.retirement.plan.expectedReturnPct,
        retirementAgeDelta: extra,
      }).readinessRatio;
    const claimed = action.steps.map((s) => /^Or work (\d+) more years?/.exec(s)).find(Boolean);
    if (claimed) {
      const years = Number(claimed[1]);
      assert.ok(readinessAfter(years) >= 1, `${p.id}: ${years} more years fully funds retirement`);
      if (years > 1) assert.ok(readinessAfter(years - 1) < 1, `${p.id}: and ${years - 1} does not`);
      assert.equal(action.evidence?.['extra working years to fully fund'], years, 'the figure is grounded');
    } else {
      assert.ok(action.steps.some((s) => s.startsWith('Working longer alone does not close it')));
      assert.ok(readinessAfter(10) < 1, `${p.id}: ten more years really is not enough`);
    }
  }
  assert.ok(checked > 0, 'at least one persona has a retirement gap');
});

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

test('durations never read "1y 12m"', () => {
  assert.equal(formatYears(1.99), '2 years');
  assert.equal(formatYears(0.999), '1 year');
  assert.equal(formatYears(0.5), '6 months');
  assert.equal(formatYears(2.25), '2y 3m');
});

test('compact money moves up a unit when rounding reaches it', () => {
  assert.equal(formatCompact(99_999.6), '₹1.00 L');
  assert.equal(formatCompact(9_999_999), '₹1.00 Cr');
  assert.equal(formatCompact(999.6), '₹1.0k');
  assert.equal(formatCompact(-0.2), '₹0', 'a value that rounds to zero carries no sign');
  assert.equal(formatCompact(-5_000), '-₹5.0k');
  assert.equal(formatCompact(12_345_678), '₹1.23 Cr');
});
