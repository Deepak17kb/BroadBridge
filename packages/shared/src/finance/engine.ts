import { DEFAULT_ASSUMPTIONS } from '../assumptions.js';
import type {
  AllocationWeights,
  FinancialSnapshot,
  Goal,
  MarketAssumptions,
  ScenarioLevers,
  ScenarioResult,
  UserProfile,
} from '../types.js';
import { generateActions } from './actions.js';
import { assessRetirement, scoreWellness, summariseCashflow, summariseNetWorth, totalMonthlyExpenses } from './cashflow.js';
import { projectGoal, yearsToGoal } from './goals.js';
import { round, sum } from './math.js';
import { runMonteCarlo } from './montecarlo.js';
import {
  analyzePortfolio,
  normaliseWeights,
  portfolioExpectedReturn,
  portfolioVolatility,
  recommendAllocation,
} from './portfolio.js';
import { scoreRisk } from './risk.js';

/**
 * The house view, with the user's ledger overrides layered on top. Both are
 * stated in INR - the platform has one currency, so nothing is restated.
 */
export function resolveAssumptions(profile: UserProfile): MarketAssumptions {
  const base = DEFAULT_ASSUMPTIONS;
  const o = profile.assumptionOverrides;
  if (!o) return base;
  return {
    ...base,
    ...o,
    expectedReturns: { ...base.expectedReturns, ...(o.expectedReturns ?? {}) },
    volatility: { ...base.volatility, ...(o.volatility ?? {}) },
    correlations: { ...base.correlations, ...(o.correlations ?? {}) },
  };
}

/** Longest goal horizon, used to set the glide path. */
export function planningHorizon(profile: UserProfile, now = new Date()): number {
  const goalYears = profile.goals.map((g) => yearsToGoal(g.targetYear, now));
  const retirementYears = Math.max(0, profile.retirementAge - profile.age);
  return Math.max(retirementYears, ...(goalYears.length ? goalYears : [0]));
}

/**
 * Per-goal return assumption.
 *
 * A goal three years out should not be projected at the retirement portfolio's
 * return - the money for it belongs in a de-risked mix. Using one blended
 * return for every goal is the most common way these tools mislead people, so
 * each goal gets the return of the allocation appropriate to *its* horizon.
 */
export function returnForGoal(
  goal: Goal,
  profile: UserProfile,
  assumptions: MarketAssumptions,
  now = new Date(),
): number {
  return portfolioExpectedReturn(allocationForGoal(goal, profile, now), assumptions);
}

/**
 * The mix the money for one goal is held in. Exported so a simulation of the
 * goal draws its volatility from the same mix its projection takes its return
 * from - the Goals page used the risk bucket's mix for every goal, so an
 * emergency fund projected at a cash return was simulated as an equity book.
 */
export function allocationForGoal(
  goal: Goal,
  profile: UserProfile,
  now = new Date(),
): AllocationWeights {
  if (goal.kind === 'emergency') {
    return { ...normaliseWeights({ ...zero(), cash: 0.7, debt: 0.3 }) } as AllocationWeights;
  }
  return recommendAllocation(scoreRisk(profile).bucket, yearsToGoal(goal.targetYear, now));
}

function zero(): AllocationWeights {
  return { equity_domestic: 0, equity_international: 0, debt: 0, gold: 0, reit: 0, cash: 0 };
}

/**
 * Single pass that produces everything the dashboard renders. Called on the
 * server for the API and in the browser for instant slider feedback - one
 * engine, so the two can never disagree.
 */
export function buildSnapshot(profile: UserProfile, now = new Date()): FinancialSnapshot {
  const assumptions = resolveAssumptions(profile);
  const risk = scoreRisk(profile);
  const horizon = planningHorizon(profile, now);
  const recommendedAllocation = recommendAllocation(risk.bucket, horizon);
  const portfolio = analyzePortfolio(
    profile.holdings,
    profile.liquidSavings,
    recommendedAllocation,
    assumptions,
  );
  const cashflow = summariseCashflow(profile, assumptions);
  const netWorth = summariseNetWorth(profile);

  const goalProjections = profile.goals
    .map((goal) =>
      projectGoal(goal, {
        annualReturn: returnForGoal(goal, profile, assumptions, now),
        assumptions,
        now,
      }),
    )
    .sort((a, b) => a.yearsToGoal - b.yearsToGoal);

  const retirement = assessRetirement({
    profile,
    assumptions,
    expectedReturnPct: portfolioExpectedReturn(recommendedAllocation, assumptions),
  });

  const goalsOnTrack = goalProjections.filter((g) => g.onTrack).length;
  const wellness = scoreWellness(
    profile,
    cashflow,
    assumptions,
    portfolio.diversificationScore,
    goalsOnTrack,
    goalProjections.length,
    retirement.readinessRatio,
  );

  const actions = generateActions({
    profile,
    cashflow,
    portfolio,
    risk,
    recommendedAllocation,
    goalProjections,
    retirement,
    assumptions,
  });

  return {
    profileId: profile.id,
    currency: profile.currency,
    generatedAt: now.toISOString(),
    netWorth,
    cashflow,
    portfolio,
    risk,
    recommendedAllocation,
    goalProjections,
    retirement,
    wellness,
    actions,
    assumptions,
  };
}

/* -------------------------------------------------------------------------- */
/* Scenario engine                                                             */
/* -------------------------------------------------------------------------- */

export interface RunScenarioOptions {
  profile: UserProfile;
  levers: ScenarioLevers;
  label?: string;
  id?: string;
  /** Baseline to diff against. Computed if omitted. */
  baseline?: FinancialSnapshot;
  paths?: number;
  seed?: number;
  now?: Date;
}

/**
 * Applies a set of levers and reports both the absolute outcome and the delta
 * against baseline. The deltas are what the UI actually shows - "you retire
 * with 1.4 Cr more" lands far harder than two large numbers side by side.
 */
export function runScenario(opts: RunScenarioOptions): ScenarioResult {
  const now = opts.now ?? new Date();
  const { profile } = opts;
  /*
   * A crash with no year is modelled in year 1 - the year the label and the
   * narration have always described it in. Left undefined, every projection
   * below skipped the shock entirely while the explanation reported one.
   */
  const levers: ScenarioLevers =
    opts.levers.marketShockPct !== undefined && opts.levers.shockYear === undefined
      ? { ...opts.levers, shockYear: 1 }
      : opts.levers;
  const baseline = opts.baseline ?? buildSnapshot(profile, now);
  const baseAssumptions = resolveAssumptions(profile);
  // `!== undefined`, not truthiness: 0% inflation is a legitimate what-if, and
  // treating it as "unset" labelled the scenario 0% while computing it at 6%.
  const assumptions: MarketAssumptions =
    levers.inflationPct !== undefined
      ? { ...baseAssumptions, inflationPct: levers.inflationPct }
      : baseAssumptions;

  const risk = scoreRisk(profile);
  const retirementAge = profile.retirementAge + (levers.retirementAgeDelta ?? 0);
  const yearsToRetirement = Math.max(1, retirementAge - profile.age);
  // The glide path must key off the same horizon the baseline used, shifted by
  // any retirement-age lever. Using a different basis here would make an
  // unrelated scenario look better purely from an allocation change.
  const horizon = Math.max(
    yearsToRetirement,
    planningHorizon(profile, now) + (levers.retirementAgeDelta ?? 0),
  );
  const allocation = levers.allocation
    ? normaliseWeights(levers.allocation)
    : recommendAllocation(risk.bucket, horizon);
  const expectedReturn = portfolioExpectedReturn(allocation, assumptions);
  const volatility = portfolioVolatility(allocation, assumptions);

  const scenarioProfile: UserProfile = {
    ...profile,
    retirementAge,
    cashflow: {
      ...profile.cashflow,
      annualIncomeGrowthPct: levers.incomeGrowthPct ?? profile.cashflow.annualIncomeGrowthPct,
      monthlyExpenses: levers.expenseMultiplier
        ? Object.fromEntries(
            Object.entries(profile.cashflow.monthlyExpenses).map(([k, v]) => [
              k,
              v * (levers.expenseMultiplier ?? 1),
            ]),
          )
        : profile.cashflow.monthlyExpenses,
    },
    assumptionOverrides:
      levers.inflationPct !== undefined
        ? { ...profile.assumptionOverrides, inflationPct: levers.inflationPct }
        : profile.assumptionOverrides,
  };

  const cashflow = summariseCashflow(scenarioProfile, assumptions);
  // Cutting expenses frees cash; that freed cash is available to invest on top
  // of whatever the user explicitly added.
  const expenseSaving =
    totalMonthlyExpenses(profile) - totalMonthlyExpenses(profile, levers.expenseMultiplier ?? 1);
  const freedSpending = Math.max(0, expenseSaving);
  const extraMonthly = (levers.extraMonthlySavings ?? 0) + freedSpending;
  const lumpSum = levers.lumpSum ?? 0;

  // Extra savings are split across off-track goals in proportion to their gap,
  // which mirrors how a planner would actually deploy new money.
  const baseProjections = profile.goals.map((goal) =>
    projectGoal(goal, {
      annualReturn: returnForGoal(goal, profile, assumptions, now),
      assumptions,
      now,
    }),
  );
  const totalGap = sum(baseProjections.map((p) => p.monthlyGap));
  const shareOf = (goal: Goal): number => {
    const base = baseProjections.find((p) => p.goalId === goal.id);
    return totalGap > 0 && base ? base.monthlyGap / totalGap : 1 / Math.max(1, profile.goals.length);
  };

  /*
   * The new money is invested once. Retirement-kind goals are already counted
   * as retirement saving by `assessRetirement`, so the retirement projection
   * receives exactly the share of the pool the split sends to them - or all of
   * it when there are no goals to split across. It used to receive the whole
   * explicit saving and lump sum on top of the goals receiving the same money,
   * which credited "save 5,000 more" with 10,000 of investing.
   */
  const retirementShare =
    profile.goals.length === 0
      ? 1
      : sum(profile.goals.filter((g) => g.kind === 'retirement').map(shareOf));

  const goalProjections = profile.goals
    .map((goal) => {
      const share = shareOf(goal);
      return projectGoal(goal, {
        // A custom allocation lever applies to the retirement portfolio. Goal
        // money stays in the mix its own horizon calls for, exactly as in the
        // baseline - this branch used the risk bucket's mix instead, which
        // re-priced the emergency fund at equity returns whenever any
        // allocation was chosen, even the recommended one.
        annualReturn: returnForGoal(goal, profile, assumptions, now),
        assumptions,
        extraMonthly: extraMonthly * share,
        lumpSum: lumpSum * share,
        skipMonths: levers.careerBreakMonths,
        shockPct: levers.marketShockPct,
        shockYear: levers.shockYear,
        now,
      });
    })
    .sort((a, b) => a.yearsToGoal - b.yearsToGoal);

  const retirement = assessRetirement({
    // `scenarioProfile` already carries the shifted retirement age. Passing
    // `retirementAgeDelta` as well applied it twice: "retire 5 years earlier"
    // was modelled as ten.
    profile: scenarioProfile,
    assumptions,
    expectedReturnPct: expectedReturn,
    extraMonthly: extraMonthly * retirementShare,
    lumpSum: lumpSum * retirementShare,
    shockPct: levers.marketShockPct,
    shockYear: levers.shockYear,
    skipMonths: levers.careerBreakMonths,
    // The freed spending is deployed through the split above, so it must not
    // also count towards the half of free surplus assumed to be invested.
    surplusCommitted: freedSpending,
  });

  const goalsOnTrack = goalProjections.filter((g) => g.onTrack).length;
  const portfolio = analyzePortfolio(
    profile.holdings,
    profile.liquidSavings,
    allocation,
    assumptions,
  );
  const wellness = scoreWellness(
    scenarioProfile,
    cashflow,
    assumptions,
    portfolio.diversificationScore,
    goalsOnTrack,
    goalProjections.length,
    retirement.readinessRatio,
  );

  /*
   * The simulation models exactly the plan the retirement projection just
   * described - same starting corpus, same contribution, same step-up - with
   * market randomness layered on top. Reconstructing those inputs here instead
   * let the two disagree, and a success probability that contradicts the
   * funding percentage beside it destroys trust in both numbers.
   */
  const monteCarlo = runMonteCarlo({
    startingCorpus: retirement.plan.startingCorpus,
    monthlyContribution: retirement.plan.monthlyContribution,
    contributionStepUpPct: retirement.plan.stepUpPct,
    years: Math.max(1, retirement.plan.years),
    expectedReturnPct: expectedReturn,
    volatilityPct: volatility,
    target: retirement.corpusRequired,
    paths: opts.paths ?? 2000,
    seed: opts.seed ?? 20260920,
    inflationPct: assumptions.inflationPct,
    shockPct: levers.marketShockPct,
    shockYear: levers.shockYear,
    // The projection pauses contributions for a career break; the simulation
    // has to as well, or its success probability ignores the lever entirely.
    skipMonths: levers.careerBreakMonths,
  });

  const snapshot = {
    netWorthAtRetirement: retirement.projectedCorpus,
    retirementReadiness: retirement.readinessRatio,
    wellnessScore: wellness.total,
    monthlySurplus: cashflow.monthlySurplus,
    goalsOnTrack,
    goalsTotal: goalProjections.length,
    expectedReturnPct: round(expectedReturn, 4),
    volatilityPct: round(volatility, 4),
  };

  const explanation = explainScenario(levers, snapshot, baseline, expectedReturn, monteCarlo.successProbability);

  return {
    id: opts.id ?? `scenario-${Date.now()}`,
    label: opts.label ?? describeLevers(levers),
    levers,
    snapshot,
    goalProjections,
    monteCarlo,
    deltaVsBaseline: {
      netWorthAtRetirement: round(retirement.projectedCorpus - baseline.retirement.projectedCorpus, 0),
      retirementReadiness: round(retirement.readinessRatio - baseline.retirement.readinessRatio, 4),
      wellnessScore: round(wellness.total - baseline.wellness.total, 0),
      goalsOnTrack: goalsOnTrack - baseline.goalProjections.filter((g) => g.onTrack).length,
    },
    explanation,
    assumptions: [
      {
        label: 'Allocation used',
        value: `${(expectedReturn * 100).toFixed(1)}% expected return, ${(volatility * 100).toFixed(1)}% volatility`,
        source: 'derived',
      },
      {
        label: 'Extra savings deployment',
        value:
          profile.goals.length === 0
            ? 'Added to retirement saving - there are no goals to split it across'
            : 'Split across off-track goals in proportion to each shortfall; retirement receives only the share that lands in retirement goals, so no rupee is counted twice',
        source: 'model_default',
      },
      {
        label: 'Freed-up spending',
        value: extraMonthly > (levers.extraMonthlySavings ?? 0)
          ? `Expense cut of ${round(expenseSaving, 0).toLocaleString('en-US')}/month is assumed to be invested, not respent`
          : 'No expense change modelled',
        source: 'model_default',
      },
      ...monteCarlo.assumptions,
    ],
  };
}

export function describeLevers(levers: ScenarioLevers): string {
  const parts: string[] = [];
  if (levers.extraMonthlySavings) parts.push(`+${compact(levers.extraMonthlySavings)}/mo saved`);
  if (levers.expenseMultiplier && levers.expenseMultiplier !== 1)
    parts.push(`${((1 - levers.expenseMultiplier) * 100).toFixed(0)}% lower spending`);
  if (levers.retirementAgeDelta) parts.push(`retire ${levers.retirementAgeDelta > 0 ? '+' : ''}${levers.retirementAgeDelta} yrs`);
  if (levers.lumpSum) parts.push(`${compact(levers.lumpSum)} lump sum`);
  if (levers.marketShockPct) parts.push(`${(levers.marketShockPct * 100).toFixed(0)}% crash in yr ${levers.shockYear ?? 1}`);
  if (levers.careerBreakMonths) parts.push(`${levers.careerBreakMonths}-month career break`);
  if (levers.incomeGrowthPct !== undefined) parts.push(`${(levers.incomeGrowthPct * 100).toFixed(0)}% income growth`);
  if (levers.inflationPct !== undefined) parts.push(`${(levers.inflationPct * 100).toFixed(1)}% inflation`);
  if (levers.allocation) parts.push('custom allocation');
  return parts.length ? parts.join(', ') : 'Baseline';
}

/**
 * Plain-language scenario narration. Deterministic by design - the numbers in
 * the sentence are the numbers from the engine, so the text can never drift
 * from the chart beside it. The LLM layer adds nuance on top, never instead.
 */
function explainScenario(
  levers: ScenarioLevers,
  snapshot: ScenarioResult['snapshot'],
  baseline: FinancialSnapshot,
  expectedReturn: number,
  successProbability: number,
): string {
  const deltaCorpus = snapshot.netWorthAtRetirement - baseline.retirement.projectedCorpus;
  const deltaReadiness = snapshot.retirementReadiness - baseline.retirement.readinessRatio;
  const lines: string[] = [];

  lines.push(
    `${describeLevers(levers)} takes your projected retirement corpus to ${compact(snapshot.netWorthAtRetirement)} - ${deltaCorpus >= 0 ? 'up' : 'down'} ${compact(Math.abs(deltaCorpus))} against your current plan.`,
  );
  lines.push(
    `That funds ${(snapshot.retirementReadiness * 100).toFixed(0)}% of what you will need (${deltaReadiness >= 0 ? '+' : ''}${(deltaReadiness * 100).toFixed(0)} points), and ${(successProbability * 100).toFixed(0)}% of simulated market paths reach the target.`,
  );
  if (snapshot.goalsOnTrack !== baseline.goalProjections.filter((g) => g.onTrack).length) {
    const diff = snapshot.goalsOnTrack - baseline.goalProjections.filter((g) => g.onTrack).length;
    lines.push(
      `${Math.abs(diff)} goal${Math.abs(diff) === 1 ? '' : 's'} ${diff > 0 ? 'moves onto' : 'falls off'} track, taking you to ${snapshot.goalsOnTrack} of ${snapshot.goalsTotal} fully funded.`,
    );
  }
  if (levers.marketShockPct) {
    lines.push(
      `The crash is modelled as a one-off ${(Math.abs(levers.marketShockPct) * 100).toFixed(0)}% drawdown in year ${levers.shockYear ?? 1}, with contributions continuing throughout - which is what makes the recovery possible.`,
    );
  }
  if (levers.careerBreakMonths) {
    lines.push(
      `The ${levers.careerBreakMonths}-month break pauses contributions but not compounding, so the cost is roughly the contributions missed plus their lost growth.`,
    );
  }
  lines.push(
    `Everything above assumes a ${(expectedReturn * 100).toFixed(1)}% average annual return and no taxes or transaction costs.`,
  );
  return lines.join(' ');
}

function compact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}k`;
  return `${sign}${abs.toFixed(0)}`;
}

/** Ready-made scenarios the UI offers as one-click presets. */
export const SCENARIO_PRESETS: { id: string; label: string; description: string; levers: ScenarioLevers }[] = [
  {
    id: 'save-more',
    label: 'Save 5,000 more each month',
    description: 'The classic "what if I just save more?" question.',
    levers: { extraMonthlySavings: 5000 },
  },
  {
    id: 'spend-less',
    label: 'Cut spending by 10%',
    description: 'Trim every expense category and invest the difference.',
    levers: { expenseMultiplier: 0.9 },
  },
  {
    id: 'retire-early',
    label: 'Retire 5 years earlier',
    description: 'Fewer earning years, more drawdown years - the hardest lever to pull.',
    levers: { retirementAgeDelta: -5 },
  },
  {
    id: 'market-crash',
    label: 'Survive a 35% crash',
    description: 'A 2008-style drawdown three years from now, with contributions continuing.',
    levers: { marketShockPct: -0.35, shockYear: 3 },
  },
  {
    id: 'career-break',
    label: 'Take a 12-month career break',
    description: 'Contributions pause for a year; compounding does not.',
    levers: { careerBreakMonths: 12 },
  },
  {
    id: 'high-inflation',
    label: 'Inflation runs at 8%',
    description: 'Every target costs more; the same corpus buys less.',
    levers: { inflationPct: 0.08 },
  },
  {
    id: 'bonus-lump-sum',
    label: 'Invest a 3 lakh bonus',
    description: 'One-off lump sum invested today instead of spent.',
    levers: { lumpSum: 300000 },
  },
];
