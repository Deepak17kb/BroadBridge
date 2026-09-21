import type { Assumption, Goal, GoalProjection, MarketAssumptions } from '../types.js';
import {
  accumulate,
  requiredMonthlyContribution,
  round,
  solveRequiredReturn,
} from './math.js';

/** Fractional years from today to 1 January of the goal year, floored at 0. */
export function yearsToGoal(targetYear: number, now = new Date()): number {
  const target = new Date(Date.UTC(targetYear, 0, 1));
  const years = (target.getTime() - now.getTime()) / (365.25 * 24 * 3600 * 1000);
  return Math.max(0, round(years, 2));
}

export interface ProjectGoalOptions {
  /** Nominal annual return the money earmarked for this goal is expected to make. */
  annualReturn: number;
  assumptions: MarketAssumptions;
  /** Extra monthly contribution layered on by a scenario. */
  extraMonthly?: number;
  /** One-off lump sum added today. */
  lumpSum?: number;
  /** Months at the start with no contributions (career break). */
  skipMonths?: number;
  /** One-off proportional drawdown, e.g. -0.3 for a 30% crash. */
  shockPct?: number;
  shockYear?: number;
  now?: Date;
}

/**
 * Projects a single goal to its target date and reports the funding gap in the
 * three forms a user can act on: how much more per month, what return would be
 * needed instead, and how far short the current plan lands.
 */
export function projectGoal(goal: Goal, opts: ProjectGoalOptions): GoalProjection {
  const now = opts.now ?? new Date();
  const years = yearsToGoal(goal.targetYear, now);
  const inflation = goal.inflationOverridePct ?? opts.assumptions.inflationPct;
  const r = opts.annualReturn;
  const monthly = goal.monthlyContribution + (opts.extraMonthly ?? 0);
  const startingCorpus = goal.currentSaved + (opts.lumpSum ?? 0);

  const inflatedTarget = goal.targetAmountToday * Math.pow(1 + inflation, years);

  const projectedCorpus = accumulate({
    startingCorpus,
    monthlyContribution: monthly,
    annualReturn: r,
    years,
    stepUpPct: goal.contributionStepUpPct,
    skipMonths: opts.skipMonths ?? 0,
    shockPct: opts.shockPct,
    shockYear: opts.shockYear,
  });

  const requiredMonthly = requiredMonthlyContribution(
    inflatedTarget,
    startingCorpus,
    r,
    years,
    goal.contributionStepUpPct,
  );
  const surplus = projectedCorpus - inflatedTarget;
  const fundedRatio = inflatedTarget > 0 ? Math.min(1, projectedCorpus / inflatedTarget) : 1;
  const requiredReturnPct =
    surplus < 0
      ? solveRequiredReturn(
          inflatedTarget,
          startingCorpus,
          monthly,
          years,
          goal.contributionStepUpPct,
        )
      : null;

  const assumptions: Assumption[] = [
    {
      label: 'Target in today’s money',
      value: formatPlain(goal.targetAmountToday),
      source: 'user_input',
    },
    {
      label: 'Inflation applied',
      value: `${(inflation * 100).toFixed(1)}%/yr for ${years.toFixed(1)} years → ${formatPlain(inflatedTarget)} at the goal date`,
      source: goal.inflationOverridePct ? 'user_input' : 'market_assumption',
    },
    {
      label: 'Assumed return',
      value: `${(r * 100).toFixed(1)}%/yr nominal, compounded monthly`,
      source: 'derived',
    },
    {
      label: 'Contribution',
      value:
        `${formatPlain(monthly)}/month` +
        (goal.contributionStepUpPct > 0
          ? `, stepped up ${(goal.contributionStepUpPct * 100).toFixed(0)}% each year`
          : ', flat (no annual step-up)'),
      source: 'user_input',
    },
    {
      label: 'Already saved',
      value: formatPlain(startingCorpus),
      source: 'user_input',
    },
  ];
  if (opts.skipMonths) {
    assumptions.push({
      label: 'Contribution pause',
      value: `First ${opts.skipMonths} months have no contribution`,
      source: 'user_input',
    });
  }
  if (opts.shockPct && opts.shockYear !== undefined) {
    assumptions.push({
      label: 'Market shock',
      value: `${(opts.shockPct * 100).toFixed(0)}% one-off move in year ${opts.shockYear}`,
      source: 'user_input',
    });
  }

  return {
    goalId: goal.id,
    goalName: goal.name,
    yearsToGoal: years,
    inflatedTarget: round(inflatedTarget, 0),
    projectedCorpus: round(projectedCorpus, 0),
    surplus: round(surplus, 0),
    fundedRatio: round(fundedRatio, 4),
    requiredMonthly: round(requiredMonthly, 0),
    monthlyGap: round(Math.max(0, requiredMonthly - monthly), 0),
    requiredReturnPct: requiredReturnPct === null ? null : round(requiredReturnPct, 4),
    assumedReturnPct: round(r, 4),
    // A goal is "on track" at 98%+ funded; demanding exactly 100% is false precision.
    onTrack: fundedRatio >= 0.98,
    assumptions,
  };
}

/**
 * Projected corpus as a percentage of the inflated target, uncapped - a goal
 * heading for 130% reads 130%, where `fundedRatio` stops at 1 because it
 * decides "on track". A goal with no target has nothing to fund and reads 0%.
 * This is what lets goals of very different sizes share one chart scale.
 */
export function fundedPercent(
  projection: Pick<GoalProjection, 'projectedCorpus' | 'inflatedTarget'>,
): number {
  return projection.inflatedTarget > 0
    ? (projection.projectedCorpus / projection.inflatedTarget) * 100
    : 0;
}

/** Compact number for assumption strings - currency symbol is added by the UI. */
function formatPlain(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e7) return `${(value / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${(value / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return value.toFixed(0);
}
