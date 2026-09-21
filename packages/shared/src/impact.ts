import type {
  ActionCategory,
  Assumption,
  FinancialSnapshot,
  NextBestAction,
  UserProfile,
  WellnessScore,
} from './types.js';
import { buildSnapshot } from './finance/engine.js';
import { planDebtPayoff } from './finance/cashflow.js';
import { runMonteCarlo } from './finance/montecarlo.js';
import { applyActionMutation } from './finance/mutations.js';
import { round } from './finance/math.js';
import { portfolioVolatility } from './finance/portfolio.js';

/**
 * What following the advice is actually worth.
 *
 * The platform has always been able to compute this and never showed it: it
 * ranks actions, it can apply them, and it can re-score the plan afterwards.
 * Doing all three in sequence turns a list of recommendations into a single
 * answer to the only question a user really has - "if I do this, what changes?"
 *
 * Two rules keep the number honest:
 *
 *  1. **Only actions the platform can actually carry out are counted.** Four of
 *     the twelve rules carry a machine-applicable mutation. The other eight
 *     recommend buying a policy, refinancing a loan or opening an account - real
 *     value, but not value this calculation can claim. They are returned
 *     separately as `notModelled` so the headline cannot quietly absorb them.
 *  2. **Actions are applied cumulatively, in rank order, and each one's
 *     contribution is measured marginally.** Reporting each action's impact in
 *     isolation and summing them double-counts every overlap - two actions that
 *     both raise the retirement corpus would each claim the same gain. The
 *     marginal figures add up to the headline by construction.
 *
 * Everything runs through `buildSnapshot` and the existing mutation appliers, so
 * the "after" state is the same state the user would reach by clicking the
 * buttons themselves.
 */

/** Fixed so the same plan always reports the same impact; surfaced in the assumptions. */
export const IMPACT_SEED = 20260920;
const IMPACT_PATHS = 1500;

export interface ImpactMetrics {
  wellnessScore: number;
  wellnessGrade: WellnessScore['grade'];
  /** 0-1. */
  retirementFundedPct: number;
  goalsOnTrack: number;
  goalsTotal: number;
  /** Interest paid over the life of the current debts, avalanche order. */
  totalInterestPaid: number;
  monthsToDebtFree: number;
  /** p50 of a seeded simulation of the retirement plan. */
  medianCorpusAtRetirement: number;
  emergencyFundMonths: number;
  /** Income less expenses, EMIs and goal contributions. Negative means the plan does not fund itself. */
  monthlySurplus: number;
}

export interface ActionContribution {
  id: string;
  title: string;
  category: ActionCategory;
  /** This action's own contribution, with the ones ranked above it already applied. */
  marginal: {
    wellnessScore: number;
    retirementFundedPct: number;
    goalsOnTrack: number;
    interestSaved: number;
    monthsToDebtFreeSaved: number;
    medianCorpusAtRetirement: number;
    emergencyFundMonths: number;
    /** Negative: what committing to this action costs you each month. */
    monthlySurplus: number;
  };
}

export interface UnmodelledAction {
  id: string;
  title: string;
  category: ActionCategory;
  /** What the user would have to do themselves. */
  why: string;
}

export interface ActionImpact {
  /** How many ranked actions were considered. */
  topN: number;
  before: ImpactMetrics;
  after: ImpactMetrics;
  applied: ActionContribution[];
  notModelled: UnmodelledAction[];
  /** True when nothing applicable was found - an already-optimised plan. */
  noop: boolean;
  seed: number;
  paths: number;
  assumptions: Assumption[];
}

function metricsFor(profile: UserProfile, snapshot: FinancialSnapshot): ImpactMetrics {
  const debt = planDebtPayoff(profile, 'avalanche', 0);
  const plan = snapshot.retirement.plan;

  /*
   * A plan with no years left to run cannot be simulated - and an already
   * retired profile is exactly the input that would divide by zero here. The
   * corpus it starts with is the honest answer in that case.
   */
  const median =
    plan.years > 0
      ? runMonteCarlo({
          startingCorpus: plan.startingCorpus,
          monthlyContribution: plan.monthlyContribution,
          contributionStepUpPct: plan.stepUpPct,
          years: plan.years,
          expectedReturnPct: plan.expectedReturnPct,
          /*
           * The volatility of the mix the plan's return comes from. Pairing the
           * recommended mix's return with the *current* holdings' volatility
           * let a rebalance move the median through volatility alone - a
           * swing of tens of lakhs either way that no expected-return change
           * backed, contradicting the explanation printed beside it.
           */
          volatilityPct: portfolioVolatility(snapshot.recommendedAllocation, snapshot.assumptions),
          target: snapshot.retirement.corpusRequired,
          paths: IMPACT_PATHS,
          seed: IMPACT_SEED,
        }).median
      : plan.startingCorpus;

  return {
    wellnessScore: snapshot.wellness.total,
    wellnessGrade: snapshot.wellness.grade,
    retirementFundedPct: snapshot.retirement.readinessRatio,
    goalsOnTrack: snapshot.goalProjections.filter((g) => g.onTrack).length,
    goalsTotal: snapshot.goalProjections.length,
    totalInterestPaid: debt.totalInterestPaid,
    monthsToDebtFree: debt.monthsToDebtFree,
    medianCorpusAtRetirement: round(median, 0),
    emergencyFundMonths: snapshot.cashflow.emergencyFundMonths,
    monthlySurplus: snapshot.cashflow.monthlySurplus,
  };
}

/**
 * Would applying this action produce a plan the user can actually fund?
 *
 * The `fund-goal-*` rules mutate a contribution by the *whole* monthly gap,
 * whether or not the surplus covers it. Counted naively, that produced headlines
 * like "retirement funded 41% -> 459%" for a profile whose surplus could not
 * carry a tenth of it - a plan nobody can run, graded higher for saying so. The
 * savings rate rises when contributions rise, so the wellness score cheerfully
 * confirms it.
 *
 * An action is therefore only counted when it leaves the surplus non-negative,
 * or at least no worse than it already was.
 */
function staysFundable(before: ImpactMetrics, after: ImpactMetrics): boolean {
  if (after.monthlySurplus >= 0) return true;
  return after.monthlySurplus >= before.monthlySurplus;
}

export interface ComputeActionImpactInput {
  profile: UserProfile;
  /** Reuses a snapshot the caller already has; rebuilt when absent. */
  snapshot?: FinancialSnapshot;
  /** Defaults to the snapshot's own ranked actions. */
  actions?: NextBestAction[];
  /** How many ranked, applicable actions to include in the headline. */
  topN?: number;
  now?: Date;
}

export function computeActionImpact(input: ComputeActionImpactInput): ActionImpact {
  const { profile, now = new Date(), topN = 3 } = input;
  const baseSnapshot = input.snapshot ?? buildSnapshot(profile, now);
  const actions = input.actions ?? baseSnapshot.actions;

  const before = metricsFor(profile, baseSnapshot);

  let working = structuredClone(profile);
  let running = before;
  const applied: ActionContribution[] = [];
  const unaffordable = new Map<string, string>();

  for (const action of actions) {
    if (applied.length >= topN) break;
    const mutation = action.apply;
    if (!mutation) continue;

    const next = structuredClone(working);
    applyActionMutation(next, mutation, {
      // The target is re-read from the *current* working state, so a rebalance
      // ranked after a contribution change still targets the right mix.
      recommendedAllocation: buildSnapshot(next, now).recommendedAllocation,
    });

    const nextSnapshot = buildSnapshot(next, now);
    const nextMetrics = metricsFor(next, nextSnapshot);

    if (!staysFundable(running, nextMetrics)) {
      unaffordable.set(
        action.id,
        `Worth doing, but not counted here: it would need about ${Math.round(
          running.monthlySurplus - nextMetrics.monthlySurplus,
        )} a month against a surplus of ${Math.round(running.monthlySurplus)}.`,
      );
      continue;
    }

    applied.push({
      id: action.id,
      title: action.title,
      category: action.category,
      marginal: {
        wellnessScore: round(nextMetrics.wellnessScore - running.wellnessScore, 1),
        retirementFundedPct: round(
          nextMetrics.retirementFundedPct - running.retirementFundedPct,
          4,
        ),
        goalsOnTrack: nextMetrics.goalsOnTrack - running.goalsOnTrack,
        // Interest *saved*, so a reduction in interest paid is a positive number.
        interestSaved: round(running.totalInterestPaid - nextMetrics.totalInterestPaid, 0),
        monthsToDebtFreeSaved: running.monthsToDebtFree - nextMetrics.monthsToDebtFree,
        medianCorpusAtRetirement: round(
          nextMetrics.medianCorpusAtRetirement - running.medianCorpusAtRetirement,
          0,
        ),
        emergencyFundMonths: round(
          nextMetrics.emergencyFundMonths - running.emergencyFundMonths,
          2,
        ),
        monthlySurplus: round(nextMetrics.monthlySurplus - running.monthlySurplus, 0),
      },
    });

    working = next;
    running = nextMetrics;
  }

  const appliedIds = new Set(applied.map((a) => a.id));
  const notModelled = actions
    .filter((a) => !appliedIds.has(a.id))
    .map((a) => ({
      id: a.id,
      title: a.title,
      category: a.category,
      why:
        unaffordable.get(a.id) ??
        (a.apply
          ? 'Applicable, but ranked below the actions included above.'
          : (a.steps[0] ?? 'Needs to be done outside the platform.')),
    }));

  return {
    topN,
    before,
    after: running,
    applied,
    notModelled,
    noop: applied.length === 0,
    seed: IMPACT_SEED,
    paths: IMPACT_PATHS,
    assumptions: [
      {
        label: 'What is counted',
        value: `${applied.length} of ${actions.length} ranked actions - only those the platform can apply for you`,
        source: 'derived',
      },
      {
        label: 'How it is measured',
        value:
          'Actions are applied cumulatively in rank order and each is credited only with what it adds on top of the ones above it, so the parts sum to the total',
        source: 'model_default',
      },
      {
        label: 'Simulation',
        value: `Median of ${IMPACT_PATHS} seeded paths (seed ${IMPACT_SEED}), so the same plan always reports the same figure`,
        source: 'model_default',
      },
      {
        label: 'Why a figure here can be negative',
        value:
          'The retirement projection assumes half of any free surplus is invested. Money an action commits to another goal leaves that surplus, so funding a goal can lower the retirement figure even while it closes the goal',
        source: 'model_default',
      },
      {
        label: 'Portfolio mix',
        value:
          'The simulation uses the return and volatility of the recommended mix, the same mix the funded percentage is computed from - rebalancing changes the portfolio, not the plan the projection already assumes',
        source: 'model_default',
      },
      {
        label: 'Affordability',
        value:
          'An action that would push your monthly surplus below zero is excluded - a plan you cannot fund is not an outcome you can reach',
        source: 'model_default',
      },
      {
        label: 'Not modelled',
        value:
          'Transaction costs, capital-gains tax on rebalancing, and every action that needs you to buy a policy, refinance or open an account',
        source: 'model_default',
      },
    ],
  };
}
