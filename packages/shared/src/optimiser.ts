import { goalPriorityWeight } from './assumptions.js';
import { accumulate, round, sum } from './finance/math.js';
import { projectGoal, yearsToGoal } from './finance/goals.js';
import { buildSnapshot, resolveAssumptions, returnForGoal } from './finance/engine.js';
import type { Assumption, FinancialSnapshot, Goal, MarketAssumptions, UserProfile } from './types.js';

/**
 * Where the surplus should actually go.
 *
 * Every other part of the platform reports each goal's gap in isolation: "add
 * 33,900 a month here", "add 1.47 lakh a month there". Added up, those numbers
 * routinely exceed everything the household has. That is not a plan, it is a
 * list of wishes, and it leaves the one decision that matters - which goal gets
 * the money - to the user.
 *
 * This allocates the pool across the goals and, just as importantly, says what
 * the goals that lose out actually lose: not a rupee shortfall, but **years of
 * delay**. "Your second home arrives four years later" is a sentence someone can
 * make a decision about; "short by 41 lakh" is not.
 *
 * The allocation is deterministic and closed-form - scored, sorted, filled. No
 * search, no randomness, so the same plan always produces the same answer and a
 * user can follow the reasoning from the weights in the Assumptions ledger.
 */

export interface GoalAllocation {
  goalId: string;
  goalName: string;
  /** What this goal needs each month to land exactly on its inflated target. */
  requiredMonthly: number;
  /** What the optimiser gives it. Never more than `requiredMonthly`. */
  allocated: number;
  /** Projected corpus / inflated target at the allocated contribution, capped at 1. */
  resultingFundedRatio: number;
  onTrack: boolean;
  shortfallAfterAllocation: number;
  /** Ordering inputs, surfaced so the result can be argued with rather than trusted. */
  score: number;
  priority: Goal['priority'];
  yearsToGoal: number;
  nearTerm: boolean;
}

export interface StarvedGoal {
  goalId: string;
  goalName: string;
  /** Monthly amount it still needs after the allocation. */
  unmetMonthly: number;
  /**
   * How much later the goal is reached at the allocated contribution, in years.
   * `null` when it is not reached within the horizon cap even so.
   */
  yearsDelayIfUnfunded: number | null;
}

export interface SurplusAllocation {
  /** The pool that was divided. */
  available: number;
  allocations: GoalAllocation[];
  starved: StarvedGoal[];
  /** Left over once every goal is fully funded; offered to the retirement gap first. */
  unallocated: number;
  /** Of `unallocated`, the part the retirement gap can absorb. */
  toRetirementGap: number;
  /** What is left after that - the `deploy-idle-cash` path. */
  toInvest: number;
  rationale: string;
  assumptions: Assumption[];
}

export interface AllocateSurplusInput {
  goals: Goal[];
  /**
   * The pool to divide.
   *
   * Callers normally pass free surplus **plus** what the goals already receive,
   * because the interesting question is rarely "where does the spare money go"
   * - most plans have none - but "is the money already committed pointed at the
   * right goals". A negative pool is allowed and means exactly what it says:
   * nothing can be allocated.
   */
  available: number;
  assumptions: MarketAssumptions;
  /** Expected return for each goal, by id. Keyed per goal because horizon drives it. */
  returnsByGoal: Record<string, number>;
  /** Monthly shortfall on retirement, which absorbs anything left over. */
  retirementGapMonthly?: number;
  now?: Date;
}

/** How many years past its target date a starved goal is searched for. */
const MAX_DELAY_YEARS = 40;

/**
 * Years of delay caused by under-funding a goal.
 *
 * Walked forward a month at a time rather than solved: the target inflates while
 * the corpus compounds, so the crossing point is where two curves meet, and the
 * honest answer when they never meet is `null` rather than an extrapolated
 * number. This is the only search in the module and it does not affect the
 * allocation - it only describes the consequence of one.
 */
function delayFromUnderfunding(
  goal: Goal,
  allocated: number,
  annualReturn: number,
  assumptions: MarketAssumptions,
  now: Date,
): number | null {
  const years = yearsToGoal(goal.targetYear, now);
  const inflation = goal.inflationOverridePct ?? assumptions.inflationPct;

  for (let extra = 0; extra <= MAX_DELAY_YEARS * 12; extra += 1) {
    const t = years + extra / 12;
    const target = goal.targetAmountToday * Math.pow(1 + inflation, t);
    const corpus = accumulate({
      startingCorpus: goal.currentSaved,
      monthlyContribution: allocated,
      annualReturn,
      years: t,
      stepUpPct: goal.contributionStepUpPct,
    });
    if (corpus >= target) return round(extra / 12, 1);
  }
  return null;
}

export function allocateSurplus(input: AllocateSurplusInput): SurplusAllocation {
  const {
    goals,
    available,
    assumptions,
    returnsByGoal,
    retirementGapMonthly = 0,
    now = new Date(),
  } = input;

  const nearTermYears = assumptions.nearTermGoalMonths / 12;

  /* 1. What each goal needs, on its own horizon and its own inflation. --------
   *
   * `projectGoal` already respects the per-goal inflation override, and the
   * return comes in per goal rather than blended - a house deposit three years
   * out is not funded from an equity-heavy mix, and pretending otherwise is the
   * most common way these tools mislead people.
   */
  const scored = goals.map((goal) => {
    const annualReturn = returnsByGoal[goal.id] ?? assumptions.expectedReturns.debt;
    const projection = projectGoal(goal, { annualReturn, assumptions, now });
    const years = projection.yearsToGoal;

    /* 2. Score = priority x urgency x deficit. ------------------------------- */
    const weight = goalPriorityWeight(goal.priority, assumptions);
    const urgency = 1 / Math.max(years, 0.5);
    const deficit = 1 - projection.fundedRatio;
    const score = weight * urgency * deficit;

    return {
      goal,
      annualReturn,
      projection,
      years,
      score,
      nearTerm: years <= nearTermYears,
    };
  });

  /*
   * 3 & 4. Order: score first, with the near-term floor applied inside each
   * priority band.
   *
   * Score has to lead - a must-have thirty years out should not outrank an
   * important goal due next year, and sorting by priority alone would do exactly
   * that. The floor is then a strict override *within* a band: a goal inside the
   * near-term window funds before a longer-horizon one of the same priority
   * whatever their scores, because a near-term goal cannot be rescued later.
   * There is no compounding left to make up the difference.
   *
   * Implemented as passes over an already score-sorted list rather than as a
   * single comparator, because "equal priority beats score" is not a transitive
   * ordering and would make a comparator-based sort unstable.
   */
  const ordered = [...scored].sort((a, b) => b.score - a.score);
  for (let pass = 0; pass < ordered.length; pass++) {
    let swapped = false;
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      const cur = ordered[i];
      if (!prev || !cur) continue;
      if (prev.goal.priority === cur.goal.priority && cur.nearTerm && !prev.nearTerm) {
        ordered[i - 1] = cur;
        ordered[i] = prev;
        swapped = true;
      }
    }
    if (!swapped) break;
  }

  /* 5. Fill greedily, capping each goal at what it needs. --------------------- */
  let remaining = Math.max(0, available);
  const allocations: GoalAllocation[] = [];
  const starved: StarvedGoal[] = [];

  for (const entry of ordered) {
    const required = entry.projection.requiredMonthly;
    const allocated = round(Math.min(required, remaining), 0);
    remaining = round(Math.max(0, remaining - allocated), 0);

    // Re-project at what it actually gets, so the funded ratio is the one the
    // user would really see rather than the one they asked for.
    const atAllocation = projectGoal(
      { ...entry.goal, monthlyContribution: allocated },
      { annualReturn: entry.annualReturn, assumptions, now },
    );

    allocations.push({
      goalId: entry.goal.id,
      goalName: entry.goal.name,
      requiredMonthly: round(required, 0),
      allocated,
      resultingFundedRatio: atAllocation.fundedRatio,
      onTrack: atAllocation.onTrack,
      shortfallAfterAllocation: round(Math.max(0, -atAllocation.surplus), 0),
      score: round(entry.score, 4),
      priority: entry.goal.priority,
      yearsToGoal: entry.years,
      nearTerm: entry.nearTerm,
    });

    /* 6. What losing out actually costs, in years. --------------------------- */
    if (allocated < required - 0.5) {
      starved.push({
        goalId: entry.goal.id,
        goalName: entry.goal.name,
        unmetMonthly: round(required - allocated, 0),
        yearsDelayIfUnfunded: delayFromUnderfunding(
          entry.goal,
          allocated,
          entry.annualReturn,
          assumptions,
          now,
        ),
      });
    }
  }

  const toRetirementGap = round(Math.min(remaining, Math.max(0, retirementGapMonthly)), 0);
  const toInvest = round(remaining - toRetirementGap, 0);

  const funded = allocations.filter((a) => a.onTrack).length;
  const first = allocations[0];
  const worst = starved.slice().sort((a, b) => (b.yearsDelayIfUnfunded ?? 99) - (a.yearsDelayIfUnfunded ?? 99))[0];

  const rationale =
    available <= 0
      ? 'There is nothing to allocate: the plan already commits more each month than it brings in. Freeing up cashflow comes before choosing between goals.'
      : [
          first
            ? `${first.goalName} is funded first - ${first.priority.replace('_', ' ')}, ${first.yearsToGoal.toFixed(1)} years out${first.nearTerm ? ' and inside the near-term window, so it funds ahead of longer-horizon goals of the same priority' : ''}.`
            : '',
          `${funded} of ${allocations.length} goals are fully funded by this split.`,
          worst && worst.yearsDelayIfUnfunded !== null
            ? `The cost is ${worst.goalName}, which arrives about ${worst.yearsDelayIfUnfunded} years later than planned.`
            : worst
              ? `${worst.goalName} is not reached at all on this split, even given ${MAX_DELAY_YEARS} more years.`
              : '',
          toRetirementGap > 0
            ? `${toRetirementGap} a month is left over and goes to the retirement shortfall.`
            : '',
        ]
          .filter(Boolean)
          .join(' ');

  return {
    available: round(available, 0),
    allocations,
    starved,
    unallocated: remaining,
    toRetirementGap,
    toInvest,
    rationale,
    assumptions: [
      {
        label: 'What is being divided',
        value: `${round(available, 0)} a month - your free surplus plus what your goals already receive`,
        source: 'derived',
      },
      {
        label: 'Priority weights',
        value: `must have ${assumptions.goalWeightMustHave}x, important ${assumptions.goalWeightImportant}x, aspirational ${assumptions.goalWeightAspirational}x - editable in the Assumptions ledger`,
        source: 'market_assumption',
      },
      {
        label: 'Ordering',
        value:
          'Priority weight x urgency (1 / years to the goal) x deficit (1 - funded ratio), highest first',
        source: 'model_default',
      },
      {
        label: 'Near-term floor',
        value: `A goal within ${assumptions.nearTermGoalMonths} months funds before longer-horizon goals of the same priority, whatever the score - there is no compounding left to rescue it`,
        source: 'market_assumption',
      },
      {
        label: 'Returns',
        value: 'Each goal is funded at the return of the mix appropriate to its own horizon, not one blended rate',
        source: 'derived',
      },
      {
        label: 'Not modelled',
        value:
          'Taxes, transaction costs, and any change to your income or spending - this divides the money as it stands today',
        source: 'model_default',
      },
    ],
  };
}

/**
 * The optimiser as the rest of the platform calls it.
 *
 * The pool defaults to free surplus **plus every rupee the goals already
 * receive**, which is the decision that makes this useful rather than academic.
 * Most real plans have no free surplus at all - Meera's is negative - so an
 * optimiser that only divided spare cash would have nothing to say to exactly
 * the person who needs it most. What it can say is that the money already
 * committed is pointed at the wrong goals.
 */
export function optimiseGoalFunding(input: {
  profile: UserProfile;
  snapshot?: FinancialSnapshot;
  /** Divide this instead of the computed pool - the "what if I had X" case. */
  surplusOverride?: number;
  now?: Date;
}): SurplusAllocation {
  const { profile, now = new Date() } = input;
  const snapshot = input.snapshot ?? buildSnapshot(profile, now);
  const assumptions = resolveAssumptions(profile);

  const committed = sum(profile.goals.map((g) => g.monthlyContribution));
  const available = input.surplusOverride ?? snapshot.cashflow.monthlySurplus + committed;

  return allocateSurplus({
    goals: profile.goals,
    available,
    assumptions,
    returnsByGoal: Object.fromEntries(
      profile.goals.map((g) => [g.id, returnForGoal(g, profile, assumptions, now)]),
    ),
    retirementGapMonthly: snapshot.retirement.monthlyGap,
    now,
  });
}
