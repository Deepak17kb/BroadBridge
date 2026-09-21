import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ASSUMPTIONS,
  HEALTH_COVER_AGE_BANDS,
  MODEL_PORTFOLIOS,
  healthCoverTarget,
} from '../src/assumptions.js';
import { PERSONAS, personaById } from '../src/data/personas.js';
import { buildSnapshot, runScenario, SCENARIO_PRESETS } from '../src/finance/engine.js';
import { fundedPercent, projectGoal } from '../src/finance/goals.js';
import { runMonteCarlo } from '../src/finance/montecarlo.js';
import {
  analyzePortfolio,
  normaliseWeights,
  portfolioExpectedReturn,
  portfolioVolatility,
  recommendAllocation,
  weightsFromHoldings,
} from '../src/finance/portfolio.js';
import { scoreRisk } from '../src/finance/risk.js';
import { applyActionMutation } from '../src/finance/mutations.js';
import { computeActionImpact } from '../src/impact.js';
import { futureValueLumpSum, steppedAnnuityFactor, sum } from '../src/finance/math.js';
import type { Goal, UserProfile } from '../src/types.js';

const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');

function persona(id: string): UserProfile {
  const p = personaById(id);
  assert.ok(p, `persona ${id} exists`);
  return structuredClone(p.profile);
}

/* -------------------------------------------------------------------------- */
/* Portfolio maths                                                             */
/* -------------------------------------------------------------------------- */

test('holding weights sum to one and include idle cash', () => {
  const profile = persona('meera');
  const weights = weightsFromHoldings(profile.holdings, profile.liquidSavings);
  assert.ok(Math.abs(sum(Object.values(weights)) - 1) < 1e-9);
  assert.ok(weights.cash > 0, 'liquid savings show up as a cash allocation');
});

test('portfolio volatility uses correlations, so diversification actually reduces risk', () => {
  const allEquity = normaliseWeights({
    equity_domestic: 1,
    equity_international: 0,
    debt: 0,
    gold: 0,
    reit: 0,
    cash: 0,
  });
  const withGold = normaliseWeights({
    equity_domestic: 0.8,
    equity_international: 0,
    debt: 0,
    gold: 0.2,
    reit: 0,
    cash: 0,
  });
  const volEquity = portfolioVolatility(allEquity, DEFAULT_ASSUMPTIONS);
  const volMixed = portfolioVolatility(withGold, DEFAULT_ASSUMPTIONS);

  // The naive weighted-average calculation would give a higher number than this,
  // because it ignores the negative equity/gold correlation.
  const naive =
    0.8 * DEFAULT_ASSUMPTIONS.volatility.equity_domestic +
    0.2 * DEFAULT_ASSUMPTIONS.volatility.gold;
  assert.ok(volMixed < volEquity, 'adding gold lowers total volatility');
  assert.ok(volMixed < naive, 'covariance-based vol is below the weighted average');
});

test('model portfolios are valid probability distributions', () => {
  for (const [bucket, weights] of Object.entries(MODEL_PORTFOLIOS)) {
    const total = sum(Object.values(weights));
    assert.ok(Math.abs(total - 1) < 1e-9, `${bucket} weights sum to 1 (got ${total})`);
    assert.ok(
      Object.values(weights).every((w) => w >= 0),
      `${bucket} has no negative weights`,
    );
  }
});

test('risk buckets are ordered by expected return', () => {
  const order = ['Conservative', 'Moderate', 'Balanced', 'Growth', 'Aggressive'] as const;
  const returns = order.map((b) =>
    portfolioExpectedReturn(MODEL_PORTFOLIOS[b], DEFAULT_ASSUMPTIONS),
  );
  for (let i = 1; i < returns.length; i++) {
    assert.ok(
      (returns[i] as number) > (returns[i - 1] as number),
      `${order[i]} should out-yield ${order[i - 1]}`,
    );
  }
});

test('glide path de-risks as the horizon shortens', () => {
  const long = recommendAllocation('Growth', 25);
  const short = recommendAllocation('Growth', 2);
  const equityOf = (w: typeof long) => w.equity_domestic + w.equity_international + w.reit;
  assert.ok(equityOf(short) < equityOf(long) * 0.6, 'a 2-year horizon cuts equity hard');
  assert.ok(Math.abs(sum(Object.values(short)) - 1) < 1e-9, 'still sums to 1 after the haircut');
});

test('rebalance trades net to roughly zero', () => {
  const profile = persona('rohan');
  const analysis = analyzePortfolio(
    profile.holdings,
    profile.liquidSavings,
    recommendAllocation('Moderate', 8),
    DEFAULT_ASSUMPTIONS,
  );
  const net = sum(analysis.drift.map((d) => d.tradeAmount));
  assert.ok(
    Math.abs(net) < analysis.totalValue * 0.001,
    `buys and sells should offset (net ${net} on ${analysis.totalValue})`,
  );
});

test('concentration is detected on the persona holding one oversized stock', () => {
  const profile = persona('rohan');
  const analysis = analyzePortfolio(
    profile.holdings,
    profile.liquidSavings,
    recommendAllocation('Moderate', 8),
    DEFAULT_ASSUMPTIONS,
  );
  assert.ok(analysis.largestPosition);
  assert.ok(analysis.largestPosition.weight > 0.15);
  assert.ok(analysis.diversificationScore < 90);
});

/* -------------------------------------------------------------------------- */
/* Risk profiling                                                              */
/* -------------------------------------------------------------------------- */

test('risk capacity is capped by a thin emergency buffer', () => {
  const profile = persona('aarav');
  const risk = scoreRisk(profile);
  assert.ok(risk.capacityScore < risk.toleranceScore, 'a 1-month buffer should cap capacity');
  assert.equal(risk.effectiveScore, Math.min(risk.toleranceScore, risk.capacityScore));
  assert.ok(risk.drivers.length > 0, 'the reasons are always explained');
});

test('an unanswered questionnaire defaults to balanced, not aggressive', () => {
  const profile = persona('meera');
  profile.riskAnswers = {};
  const risk = scoreRisk(profile);
  assert.ok(risk.toleranceScore === 50);
  assert.ok(risk.drivers.some((d) => d.includes('not completed')));
});

/* -------------------------------------------------------------------------- */
/* Goal projection                                                             */
/* -------------------------------------------------------------------------- */

const sampleGoal: Goal = {
  id: 'test-goal',
  name: 'Test',
  kind: 'custom',
  targetAmountToday: 5_000_000,
  targetYear: FIXED_NOW.getUTCFullYear() + 10,
  currentSaved: 500_000,
  monthlyContribution: 20_000,
  contributionStepUpPct: 0.05,
  priority: 'important',
};

test('projectGoal inflates the target to the goal date', () => {
  const p = projectGoal(sampleGoal, {
    annualReturn: 0.11,
    assumptions: DEFAULT_ASSUMPTIONS,
    now: FIXED_NOW,
  });
  const expected = 5_000_000 * Math.pow(1 + DEFAULT_ASSUMPTIONS.inflationPct, p.yearsToGoal);
  assert.ok(Math.abs(p.inflatedTarget - expected) < 1, 'target is inflated, not taken at face value');
  assert.ok(p.inflatedTarget > sampleGoal.targetAmountToday);
});

test('projectGoal required contribution closes the gap exactly', () => {
  const p = projectGoal(sampleGoal, {
    annualReturn: 0.11,
    assumptions: DEFAULT_ASSUMPTIONS,
    now: FIXED_NOW,
  });
  const achieved =
    futureValueLumpSum(sampleGoal.currentSaved, 0.11, p.yearsToGoal) +
    p.requiredMonthly * steppedAnnuityFactor(0.11, p.yearsToGoal, sampleGoal.contributionStepUpPct);
  assert.ok(Math.abs(achieved - p.inflatedTarget) / p.inflatedTarget < 1e-6);
});

test('extra monthly savings strictly improve a projection', () => {
  const base = projectGoal(sampleGoal, {
    annualReturn: 0.11,
    assumptions: DEFAULT_ASSUMPTIONS,
    now: FIXED_NOW,
  });
  const boosted = projectGoal(sampleGoal, {
    annualReturn: 0.11,
    assumptions: DEFAULT_ASSUMPTIONS,
    extraMonthly: 10_000,
    now: FIXED_NOW,
  });
  assert.ok(boosted.projectedCorpus > base.projectedCorpus);
  assert.ok(boosted.monthlyGap <= base.monthlyGap);
});

test('a market shock reduces the projected corpus but leaves room to recover', () => {
  const base = projectGoal(sampleGoal, {
    annualReturn: 0.11,
    assumptions: DEFAULT_ASSUMPTIONS,
    now: FIXED_NOW,
  });
  const crashed = projectGoal(sampleGoal, {
    annualReturn: 0.11,
    assumptions: DEFAULT_ASSUMPTIONS,
    shockPct: -0.35,
    shockYear: 3,
    now: FIXED_NOW,
  });
  assert.ok(crashed.projectedCorpus < base.projectedCorpus);
  // Contributions keep flowing, so a 35% hit in year 3 must not cost 35% of the end value.
  assert.ok(crashed.projectedCorpus > base.projectedCorpus * 0.65);
});

test('every projection carries its assumptions', () => {
  const p = projectGoal(sampleGoal, {
    annualReturn: 0.11,
    assumptions: DEFAULT_ASSUMPTIONS,
    now: FIXED_NOW,
  });
  assert.ok(p.assumptions.length >= 4);
  assert.ok(p.assumptions.every((a) => a.label && a.value && a.source));
});

/* -------------------------------------------------------------------------- */
/* Monte Carlo                                                                 */
/* -------------------------------------------------------------------------- */

const mcInput = {
  startingCorpus: 1_000_000,
  monthlyContribution: 25_000,
  contributionStepUpPct: 0.05,
  years: 20,
  expectedReturnPct: 0.11,
  volatilityPct: 0.15,
  target: 20_000_000,
  paths: 1500,
  seed: 777,
};

test('Monte Carlo is reproducible for a given seed', () => {
  const a = runMonteCarlo(mcInput);
  const b = runMonteCarlo(mcInput);
  assert.deepEqual(a.bands, b.bands);
  assert.equal(a.successProbability, b.successProbability);
});

test('Monte Carlo percentile bands are correctly ordered', () => {
  const result = runMonteCarlo(mcInput);
  for (const band of result.bands) {
    assert.ok(band.p10 <= band.p25, `p10 <= p25 in year ${band.year}`);
    assert.ok(band.p25 <= band.p50, `p25 <= p50 in year ${band.year}`);
    assert.ok(band.p50 <= band.p75, `p50 <= p75 in year ${band.year}`);
    assert.ok(band.p75 <= band.p90, `p75 <= p90 in year ${band.year}`);
  }
  assert.equal(result.bands.length, mcInput.years);
});

test('Monte Carlo median tracks the deterministic projection', () => {
  // With the variance drag removed, the simulated median should land close to
  // the closed-form future value. A wide miss means the drift is wrong.
  const result = runMonteCarlo({ ...mcInput, paths: 8000, volatilityPct: 0.15 });
  const deterministic =
    futureValueLumpSum(mcInput.startingCorpus, mcInput.expectedReturnPct, mcInput.years) +
    mcInput.monthlyContribution *
      steppedAnnuityFactor(mcInput.expectedReturnPct, mcInput.years, mcInput.contributionStepUpPct);
  const ratio = result.median / deterministic;
  // Log-normal terminal values are right-skewed, so the median sits below the
  // mean - but it should stay within a sane band of the deterministic figure.
  assert.ok(ratio > 0.6 && ratio < 1.05, `median/deterministic = ${ratio.toFixed(3)}`);
});

test('higher contributions raise the success probability', () => {
  const low = runMonteCarlo({ ...mcInput, monthlyContribution: 15_000 });
  const high = runMonteCarlo({ ...mcInput, monthlyContribution: 45_000 });
  assert.ok(high.successProbability > low.successProbability);
});

test('the histogram accounts for every simulated path in range', () => {
  const result = runMonteCarlo(mcInput);
  const counted = sum(result.histogram.map((b) => b.count));
  assert.equal(counted, result.paths);
});

test('inflation adjustment reports a smaller number in real terms', () => {
  const nominal = runMonteCarlo(mcInput);
  const real = runMonteCarlo({ ...mcInput, inflationPct: 0.06 });
  assert.ok(real.median < nominal.median);
});

/* -------------------------------------------------------------------------- */
/* Snapshot invariants                                                         */
/* -------------------------------------------------------------------------- */

for (const p of PERSONAS) {
  test(`snapshot invariants hold for ${p.id}`, () => {
    const snapshot = buildSnapshot(structuredClone(p.profile), FIXED_NOW);

    assert.equal(
      snapshot.netWorth.netWorth,
      snapshot.netWorth.assets - snapshot.netWorth.liabilities,
      'net worth reconciles',
    );
    assert.ok(snapshot.wellness.total >= 0 && snapshot.wellness.total <= 100);
    assert.ok(
      Math.abs(sum(snapshot.wellness.pillars.map((x) => x.weight)) - 1) < 1e-9,
      'pillar weights sum to 1',
    );
    assert.ok(
      Math.abs(sum(Object.values(snapshot.recommendedAllocation)) - 1) < 1e-9,
      'recommended allocation sums to 1',
    );
    assert.equal(snapshot.goalProjections.length, p.profile.goals.length);
    assert.ok(snapshot.actions.length > 0, 'every persona gets at least one action');

    // Actions must arrive pre-ranked, and every one must be explainable.
    for (let i = 1; i < snapshot.actions.length; i++) {
      const prev = snapshot.actions[i - 1];
      const cur = snapshot.actions[i];
      assert.ok((prev?.priorityScore ?? 0) >= (cur?.priorityScore ?? 0), 'actions are sorted');
    }
    for (const action of snapshot.actions) {
      assert.ok(action.why.length > 20, `${action.id} explains itself`);
      assert.ok(action.steps.length > 0, `${action.id} has steps`);
      assert.ok(action.assumptions.length > 0, `${action.id} declares assumptions`);
      assert.ok(Number.isFinite(action.impact.value), `${action.id} has a finite impact`);
    }
  });
}

test('the persona with 42% card debt is told to clear it first', () => {
  const snapshot = buildSnapshot(persona('aarav'), FIXED_NOW);
  const top = snapshot.actions[0];
  assert.ok(top);
  assert.ok(
    top.id === 'clear-expensive-debt' || top.id === 'build-emergency-fund',
    `expected debt or buffer first, got ${top.id}`,
  );
  assert.ok(snapshot.actions.some((a) => a.id === 'clear-expensive-debt'));
  // Investing advice must not outrank clearing 42% debt.
  const debtIdx = snapshot.actions.findIndex((a) => a.id === 'clear-expensive-debt');
  const investIdx = snapshot.actions.findIndex((a) => a.category === 'investing');
  if (investIdx >= 0) assert.ok(debtIdx < investIdx);
});

/* -------------------------------------------------------------------------- */
/* Health cover                                                                */
/* -------------------------------------------------------------------------- */

test('the under-insured persona is told to raise health cover, by the right amount', () => {
  const profile = persona('meera');
  const snapshot = buildSnapshot(profile, FIXED_NOW);
  const action = snapshot.actions.find((a) => a.id === 'close-health-cover-gap');
  assert.ok(action, 'Meera holds 10L against two dependents and 27L of income');

  const annualIncome =
    (profile.cashflow.monthlyNetIncome + profile.cashflow.otherMonthlyIncome) * 12;
  const expectedTarget = healthCoverTarget({
    annualIncome,
    age: profile.age,
    dependents: profile.dependents,
    assumptions: DEFAULT_ASSUMPTIONS,
  });
  const expectedGap = expectedTarget - (profile.healthInsuranceCover ?? 0);

  assert.equal(action.evidence?.['health cover needed'], expectedTarget);
  assert.equal(action.evidence?.['health cover gap'], expectedGap);
  assert.equal(action.impact.value, Math.round(expectedGap));
  assert.equal(action.category, 'protection');

  // The knock-on the rule exists to surface: an uncovered event is paid out of
  // the emergency fund, so the buffer the plan assumes is not actually enough.
  assert.equal(
    action.evidence?.['emergency fund target if uninsured'],
    snapshot.cashflow.emergencyFundTarget + expectedGap,
  );
});

test('an adequately covered profile gets no health-cover action', () => {
  const profile = persona('meera');
  const annualIncome =
    (profile.cashflow.monthlyNetIncome + profile.cashflow.otherMonthlyIncome) * 12;
  profile.healthInsuranceCover = healthCoverTarget({
    annualIncome,
    age: profile.age,
    dependents: profile.dependents,
    assumptions: DEFAULT_ASSUMPTIONS,
  });

  const snapshot = buildSnapshot(profile, FIXED_NOW);
  assert.ok(
    !snapshot.actions.some((a) => a.id === 'close-health-cover-gap'),
    'cover exactly at target leaves no gap, so no action',
  );
});

test('zero health cover with dependents ranks urgent', () => {
  const uninsured = persona('meera');
  uninsured.healthInsuranceCover = 0;
  const uninsuredAction = buildSnapshot(uninsured, FIXED_NOW).actions.find(
    (a) => a.id === 'close-health-cover-gap',
  );
  assert.ok(uninsuredAction);
  // 70 is the threshold the shell badge and the Actions page call "urgent".
  assert.ok(
    uninsuredAction.priorityScore >= 70,
    `expected urgent, got ${uninsuredAction.priorityScore}`,
  );
  assert.match(uninsuredAction.title, /you have none/);

  const partial = persona('meera');
  const partialAction = buildSnapshot(partial, FIXED_NOW).actions.find(
    (a) => a.id === 'close-health-cover-gap',
  );
  assert.ok(partialAction);
  assert.ok(
    uninsuredAction.priorityScore > partialAction.priorityScore,
    'no cover at all must outrank partial cover',
  );

  // Urgency also has to move with dependents, holding cover constant.
  const noDependents = persona('meera');
  noDependents.healthInsuranceCover = 0;
  noDependents.dependents = 0;
  const noDepAction = buildSnapshot(noDependents, FIXED_NOW).actions.find(
    (a) => a.id === 'close-health-cover-gap',
  );
  assert.ok(noDepAction);
  assert.ok(
    uninsuredAction.priorityScore > noDepAction.priorityScore,
    'two dependents must outrank none at the same cover level',
  );
});

test('health cover sits immediately below life cover in the protection waterfall', () => {
  for (const p of PERSONAS) {
    const actions = buildSnapshot(p.profile, FIXED_NOW).actions;
    const life = actions.find((a) => a.id === 'close-life-cover-gap');
    const health = actions.find((a) => a.id === 'close-health-cover-gap');
    if (!life || !health) continue;

    assert.ok(
      health.priorityScore < life.priorityScore,
      `${p.id}: a death with dependents and no cover is unrecoverable; a medical event is not`,
    );

    // Among protection actions specifically, nothing may come between them.
    const protection = actions.filter((a) => a.category === 'protection');
    const lifeIdx = protection.findIndex((a) => a.id === 'close-life-cover-gap');
    const healthIdx = protection.findIndex((a) => a.id === 'close-health-cover-gap');
    assert.equal(healthIdx, lifeIdx + 1, `${p.id}: health cover ranks immediately after life cover`);
  }
});

test('the health-cover target is the higher of the income rule and the age floor', () => {
  // Low earner, young: the floor binds, because one admission costs what it costs.
  const lowIncomeYoung = healthCoverTarget({
    annualIncome: 200_000,
    age: 26,
    dependents: 0,
    assumptions: DEFAULT_ASSUMPTIONS,
  });
  assert.equal(lowIncomeYoung, DEFAULT_ASSUMPTIONS.healthCoverFloorUnder40);

  // High earner: the income multiple binds instead.
  const highIncome = healthCoverTarget({
    annualIncome: 10_000_000,
    age: 26,
    dependents: 0,
    assumptions: DEFAULT_ASSUMPTIONS,
  });
  assert.equal(highIncome, 10_000_000 * DEFAULT_ASSUMPTIONS.healthCoverIncomeMultiple);

  // The floor steps up with age at the published band boundaries.
  const floorArgs = { annualIncome: 0, dependents: 0, assumptions: DEFAULT_ASSUMPTIONS };
  assert.equal(
    healthCoverTarget({ ...floorArgs, age: HEALTH_COVER_AGE_BANDS.youngMaxAge - 1 }),
    DEFAULT_ASSUMPTIONS.healthCoverFloorUnder40,
  );
  assert.equal(
    healthCoverTarget({ ...floorArgs, age: HEALTH_COVER_AGE_BANDS.youngMaxAge }),
    DEFAULT_ASSUMPTIONS.healthCoverFloor40To55,
  );
  assert.equal(
    healthCoverTarget({ ...floorArgs, age: HEALTH_COVER_AGE_BANDS.midMaxAge }),
    DEFAULT_ASSUMPTIONS.healthCoverFloorOver55,
  );

  // Dependents load on top of whichever of the two binds.
  assert.equal(
    healthCoverTarget({ ...floorArgs, age: 26, dependents: 2 }),
    DEFAULT_ASSUMPTIONS.healthCoverFloorUnder40 + 2 * DEFAULT_ASSUMPTIONS.healthCoverPerDependent,
  );
});

test('the wellness pillar scores health cover against the same target the rule uses', () => {
  // These were two different models: the pillar hardcoded 0.5x income while the
  // rule used the editable multiple, the age floor and the dependent loading. A
  // user raising the multiple saw the action change and the score that grades
  // them stay put.
  const base = persona('meera');
  const raised = persona('meera');
  raised.assumptionOverrides = { healthCoverIncomeMultiple: 1.5 };

  const protectionOf = (p: UserProfile) => {
    const pillar = buildSnapshot(p, FIXED_NOW).wellness.pillars.find((x) => x.name === 'Protection');
    assert.ok(pillar);
    return pillar.score;
  };

  assert.ok(
    protectionOf(raised) < protectionOf(base),
    'demanding more cover for the same policy must lower the protection score',
  );
});

test('a user-edited health-cover assumption re-scores the gap', () => {
  const profile = persona('rohan');
  const base = buildSnapshot(profile, FIXED_NOW).actions.find(
    (a) => a.id === 'close-health-cover-gap',
  );
  assert.ok(base);

  // Every constant in the model is the user's to change, like the rest of the ledger.
  profile.assumptionOverrides = { healthCoverIncomeMultiple: 1 };
  const raised = buildSnapshot(profile, FIXED_NOW).actions.find(
    (a) => a.id === 'close-health-cover-gap',
  );
  assert.ok(raised);
  assert.ok(
    (raised.evidence?.['health cover gap'] ?? 0) > (base.evidence?.['health cover gap'] ?? 0),
    'doubling the income multiple must widen the gap',
  );
});

/* -------------------------------------------------------------------------- */
/* Action impact                                                               */
/* -------------------------------------------------------------------------- */

for (const p of PERSONAS) {
  test(`impact for ${p.id} is real, finite and adds up`, () => {
    const impact = computeActionImpact({ profile: p.profile, topN: 3, now: FIXED_NOW });

    assert.ok(impact.applied.length > 0, 'every persona has something the platform can do for them');
    assert.ok(impact.applied.length <= 3);
    assert.equal(impact.noop, false);

    for (const metrics of [impact.before, impact.after]) {
      for (const [key, value] of Object.entries(metrics)) {
        if (typeof value === 'number') {
          assert.ok(Number.isFinite(value), `${key} is finite`);
        }
      }
    }

    // The marginals are the whole claim: applied cumulatively in rank order,
    // they must reconstruct the headline exactly, or the breakdown is decorative.
    const summed = impact.applied.reduce((acc, a) => acc + a.marginal.wellnessScore, 0);
    assert.ok(
      Math.abs(impact.after.wellnessScore - impact.before.wellnessScore - summed) < 0.05,
      `marginal wellness deltas must sum to the headline change (got ${summed})`,
    );

    const summedCorpus = impact.applied.reduce(
      (acc, a) => acc + a.marginal.medianCorpusAtRetirement,
      0,
    );
    assert.ok(
      Math.abs(
        impact.after.medianCorpusAtRetirement - impact.before.medianCorpusAtRetirement - summedCorpus,
      ) < 1,
      'marginal corpus deltas must sum to the headline change',
    );

    // Nothing that cannot be applied may hide inside the headline.
    const appliedIds = new Set(impact.applied.map((a) => a.id));
    assert.ok(
      impact.notModelled.every((n) => !appliedIds.has(n.id)),
      'an action is counted or excluded, never both',
    );
    assert.ok(
      impact.notModelled.every((n) => n.why.length > 10),
      'every excluded action says why',
    );
  });
}

test('impact is reproducible: the same plan reports the same numbers', () => {
  const profile = persona('meera');
  const a = computeActionImpact({ profile, topN: 3, now: FIXED_NOW });
  const b = computeActionImpact({ profile, topN: 3, now: FIXED_NOW });
  assert.deepEqual(a, b, 'a seeded simulation and deterministic mutations must not wobble');

  // And it must not mutate the profile it was handed.
  assert.deepEqual(profile, persona('meera'), 'computeActionImpact does not touch its input');
});

test('impact never counts an action the user cannot fund', () => {
  // The fund-goal rules mutate a contribution by the whole monthly gap whether
  // or not the surplus covers it. Counted naively that produced "retirement
  // funded 41% -> 459%" for a profile running a monthly deficit.
  for (const p of PERSONAS) {
    const impact = computeActionImpact({ profile: p.profile, topN: 3, now: FIXED_NOW });
    if (impact.before.monthlySurplus >= 0) {
      assert.ok(
        impact.after.monthlySurplus >= 0,
        `${p.id}: a positive surplus must not be spent into deficit`,
      );
    } else {
      assert.ok(
        impact.after.monthlySurplus >= impact.before.monthlySurplus,
        `${p.id}: an existing deficit must not be made worse`,
      );
    }
  }

  // The excluded ones are reported with the arithmetic, not silently dropped.
  const rohan = computeActionImpact({ profile: persona('rohan'), topN: 3, now: FIXED_NOW });
  const skipped = rohan.notModelled.filter((n) => n.why.startsWith('Worth doing'));
  assert.ok(skipped.length > 0, 'Rohan cannot fund a 7.25 L/month contribution increase');
});

test('an already-optimised plan reports zero impact without dividing by zero', () => {
  const profile = persona('rohan');

  // Apply everything the platform can, repeatedly, until nothing is left that
  // both applies and is affordable.
  for (let i = 0; i < 12; i++) {
    const impact = computeActionImpact({ profile, topN: 5, now: FIXED_NOW });
    if (impact.noop) break;
    const snapshot = buildSnapshot(profile, FIXED_NOW);
    for (const contribution of impact.applied) {
      const action = snapshot.actions.find((a) => a.id === contribution.id);
      if (action?.apply) {
        applyActionMutation(profile, action.apply, {
          recommendedAllocation: snapshot.recommendedAllocation,
        });
      }
    }
  }

  const settled = computeActionImpact({ profile, topN: 5, now: FIXED_NOW });
  for (const value of Object.values(settled.after)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value));
  }
  if (settled.noop) {
    assert.deepEqual(settled.after, settled.before, 'nothing applied means nothing changed');
    assert.equal(settled.applied.length, 0);
  }
});

test('a retired profile does not divide by zero in the simulation', () => {
  const profile = persona('rohan');
  profile.retirementAge = profile.age; // no years left to accumulate
  const impact = computeActionImpact({ profile, topN: 3, now: FIXED_NOW });
  assert.ok(Number.isFinite(impact.before.medianCorpusAtRetirement));
  assert.ok(Number.isFinite(impact.after.medianCorpusAtRetirement));
});

test('fundedPercent is the uncapped share of the target, and 0 with no target', () => {
  assert.equal(fundedPercent({ projectedCorpus: 50, inflatedTarget: 200 }), 25);
  assert.equal(
    fundedPercent({ projectedCorpus: 260, inflatedTarget: 200 }),
    130,
    'an over-funded goal is not capped at 100 the way fundedRatio is',
  );
  assert.equal(fundedPercent({ projectedCorpus: 1000, inflatedTarget: 0 }), 0);

  // Below 100% it is the same measure as fundedRatio, on a 0-100 scale.
  for (const g of buildSnapshot(persona('meera'), FIXED_NOW).goalProjections) {
    if (g.fundedRatio < 1) {
      assert.ok(Math.abs(fundedPercent(g) / 100 - g.fundedRatio) < 0.001, `${g.goalName} agrees with fundedRatio`);
    }
  }
});

test('education inflation override is respected', () => {
  const snapshot = buildSnapshot(persona('meera'), FIXED_NOW);
  const education = snapshot.goalProjections.find((g) => g.goalName.includes('Education'));
  assert.ok(education);
  const naive = 6_000_000 * Math.pow(1 + DEFAULT_ASSUMPTIONS.inflationPct, education.yearsToGoal);
  assert.ok(
    education.inflatedTarget > naive,
    'the 10% education inflation override must raise the target above headline inflation',
  );
});

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                   */
/* -------------------------------------------------------------------------- */

test('saving more always improves the outcome', () => {
  const profile = persona('meera');
  const baseline = buildSnapshot(profile, FIXED_NOW);
  const result = runScenario({
    profile,
    levers: { extraMonthlySavings: 20_000 },
    baseline,
    paths: 800,
    now: FIXED_NOW,
  });
  assert.ok(result.deltaVsBaseline.netWorthAtRetirement > 0);
  assert.ok(result.snapshot.retirementReadiness >= baseline.retirement.readinessRatio);
  assert.ok(result.explanation.length > 50, 'the scenario narrates itself');
});

test('retiring earlier lowers readiness', () => {
  const profile = persona('meera');
  const baseline = buildSnapshot(profile, FIXED_NOW);
  const result = runScenario({
    profile,
    levers: { retirementAgeDelta: -5 },
    baseline,
    paths: 800,
    now: FIXED_NOW,
  });
  assert.ok(
    result.snapshot.retirementReadiness < baseline.retirement.readinessRatio,
    'fewer earning years and more drawdown years must hurt',
  );
});

test('a crash hurts, and the hit is bounded by the contributions that continue', () => {
  const profile = persona('rohan');
  const baseline = buildSnapshot(profile, FIXED_NOW);
  const result = runScenario({
    profile,
    levers: { marketShockPct: -0.35, shockYear: 3 },
    baseline,
    paths: 800,
    now: FIXED_NOW,
  });
  assert.ok(result.deltaVsBaseline.netWorthAtRetirement < 0);
  assert.ok(
    result.snapshot.netWorthAtRetirement > baseline.retirement.projectedCorpus * 0.5,
    'a one-off 35% drawdown must not halve the final corpus',
  );
});

test('cutting expenses both frees cash and lowers the retirement bar', () => {
  const profile = persona('meera');
  const baseline = buildSnapshot(profile, FIXED_NOW);
  const result = runScenario({
    profile,
    levers: { expenseMultiplier: 0.9 },
    baseline,
    paths: 800,
    now: FIXED_NOW,
  });
  assert.ok(result.snapshot.monthlySurplus > baseline.cashflow.monthlySurplus);
  assert.ok(result.snapshot.retirementReadiness > baseline.retirement.readinessRatio);
});

test('every shipped preset runs and produces a comparable result', () => {
  const profile = persona('aarav');
  const baseline = buildSnapshot(profile, FIXED_NOW);
  for (const preset of SCENARIO_PRESETS) {
    const result = runScenario({
      profile,
      levers: preset.levers,
      label: preset.label,
      baseline,
      paths: 400,
      now: FIXED_NOW,
    });
    assert.ok(Number.isFinite(result.snapshot.netWorthAtRetirement), `${preset.id} is finite`);
    assert.ok(result.snapshot.netWorthAtRetirement >= 0, `${preset.id} is non-negative`);
    assert.ok(result.monteCarlo.bands.length > 0, `${preset.id} produced bands`);
    assert.ok(result.assumptions.length > 0, `${preset.id} declares assumptions`);
  }
});

test('scenarios are deterministic across runs', () => {
  const profile = persona('aarav');
  const levers = { extraMonthlySavings: 5000 };
  const a = runScenario({ profile, levers, paths: 500, seed: 11, now: FIXED_NOW });
  const b = runScenario({ profile, levers, paths: 500, seed: 11, now: FIXED_NOW });
  assert.equal(a.snapshot.netWorthAtRetirement, b.snapshot.netWorthAtRetirement);
  assert.equal(a.monteCarlo.successProbability, b.monteCarlo.successProbability);
});
