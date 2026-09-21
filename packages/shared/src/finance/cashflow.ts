import type {
  Assumption,
  CashflowSummary,
  DebtPayoffPlan,
  MarketAssumptions,
  NetWorthSummary,
  RetirementReadiness,
  UserProfile,
  WellnessScore,
} from '../types.js';
import { healthCoverTarget } from '../assumptions.js';
import { holdingValue } from './portfolio.js';
import {
  accumulate,
  clamp,
  monthlyRate,
  requiredMonthlyContribution,
  round,
  sum,
} from './math.js';

export function totalMonthlyExpenses(profile: UserProfile, multiplier = 1): number {
  return sum(Object.values(profile.cashflow.monthlyExpenses)) * multiplier;
}

export function summariseCashflow(
  profile: UserProfile,
  assumptions: MarketAssumptions,
  expenseMultiplier = 1,
): CashflowSummary {
  const monthlyIncome = profile.cashflow.monthlyNetIncome + profile.cashflow.otherMonthlyIncome;
  const monthlyExpenses = totalMonthlyExpenses(profile, expenseMultiplier);
  const totalEmi = sum(profile.liabilities.map((l) => l.emi));
  const goalContributions = sum(profile.goals.map((g) => g.monthlyContribution));

  // Surplus is what is left *after* goals are funded - that is the number the
  // user can actually redeploy, and the one the action engine spends.
  const monthlySurplus = monthlyIncome - monthlyExpenses - totalEmi - goalContributions;
  const savingsRatePct = monthlyIncome > 0 ? (monthlySurplus + goalContributions) / monthlyIncome : 0;

  const emergencyFundTarget = monthlyExpenses * assumptions.emergencyFundMonths;
  const emergencyFundMonths = monthlyExpenses > 0 ? profile.liquidSavings / monthlyExpenses : 0;

  const expenseBreakdown = Object.entries(profile.cashflow.monthlyExpenses)
    .map(([category, raw]) => {
      const amount = raw * expenseMultiplier;
      return {
        category,
        amount: round(amount, 0),
        sharePct: round(monthlyExpenses > 0 ? amount / monthlyExpenses : 0, 4),
      };
    })
    .sort((a, b) => b.amount - a.amount);

  return {
    monthlyIncome: round(monthlyIncome, 0),
    monthlyExpenses: round(monthlyExpenses, 0),
    monthlySurplus: round(monthlySurplus, 0),
    savingsRatePct: round(savingsRatePct, 4),
    totalEmi: round(totalEmi, 0),
    debtToIncomeRatio: round(monthlyIncome > 0 ? totalEmi / monthlyIncome : 0, 4),
    emergencyFundMonths: round(emergencyFundMonths, 1),
    emergencyFundTarget: round(emergencyFundTarget, 0),
    emergencyFundGap: round(Math.max(0, emergencyFundTarget - profile.liquidSavings), 0),
    expenseBreakdown,
  };
}

export function summariseNetWorth(profile: UserProfile): NetWorthSummary {
  const investedAssets = sum(profile.holdings.map(holdingValue));
  const goalSavings = sum(profile.goals.map((g) => g.currentSaved));
  const liquidAssets = profile.liquidSavings;
  const assets = investedAssets + liquidAssets + goalSavings;
  const liabilities = sum(profile.liabilities.map((l) => l.outstanding));
  return {
    assets: round(assets, 0),
    liabilities: round(liabilities, 0),
    netWorth: round(assets - liabilities, 0),
    liquidAssets: round(liquidAssets, 0),
    investedAssets: round(investedAssets + goalSavings, 0),
  };
}

export interface RetirementInput {
  profile: UserProfile;
  assumptions: MarketAssumptions;
  /** Expected nominal return on the retirement corpus while accumulating. */
  expectedReturnPct: number;
  expenseMultiplier?: number;
  extraMonthly?: number;
  retirementAgeDelta?: number;
  lumpSum?: number;
  /** One-off proportional drawdown applied during accumulation. */
  shockPct?: number;
  shockYear?: number;
  /** Months during which contributions stop (career break). */
  skipMonths?: number;
  /**
   * Part of the free surplus the caller has already committed elsewhere - a
   * scenario's expense cut that it deploys to goals - so it is not also counted
   * as habitual saving. Without this the same rupee was invested twice.
   */
  surplusCommitted?: number;
}

/**
 * Retirement sizing with a real-return drawdown, not a flat 25x rule.
 *
 * Corpus required = inflated annual spend / safe withdrawal rate. We then
 * simulate the drawdown year by year at a de-risked post-retirement return to
 * find the age the money would actually run out, which is far more legible to a
 * user than a single "you need X crore" figure.
 */
export function assessRetirement(input: RetirementInput): RetirementReadiness {
  const { profile, assumptions } = input;
  const retirementAge = profile.retirementAge + (input.retirementAgeDelta ?? 0);
  const yearsToRetirement = Math.max(0, retirementAge - profile.age);
  const monthlyExpensesNow = totalMonthlyExpenses(profile, input.expenseMultiplier ?? 1);

  // EMIs are assumed discharged by retirement, so they are excluded from the
  // spend that has to be funded forever.
  const annualSpendNow = monthlyExpensesNow * 12;
  const targetAnnualSpend =
    annualSpendNow * Math.pow(1 + assumptions.inflationPct, yearsToRetirement);
  const corpusRequired = targetAnnualSpend / assumptions.safeWithdrawalRatePct;

  // Money already pointed at retirement: invested assets, liquid savings above
  // the emergency floor, and anything sitting in a retirement-kind goal.
  const emergencyFloor = monthlyExpensesNow * assumptions.emergencyFundMonths;
  const investable =
    sum(profile.holdings.map(holdingValue)) +
    Math.max(0, profile.liquidSavings - emergencyFloor) +
    sum(profile.goals.filter((g) => g.kind === 'retirement').map((g) => g.currentSaved)) +
    (input.lumpSum ?? 0);

  const retirementGoalContribution = sum(
    profile.goals.filter((g) => g.kind === 'retirement').map((g) => g.monthlyContribution),
  );
  const cashflow = summariseCashflow(profile, assumptions, input.expenseMultiplier ?? 1);
  // Half of any free surplus is assumed to keep flowing to long-term investing.
  const habitualSaving =
    Math.max(0, cashflow.monthlySurplus - Math.max(0, input.surplusCommitted ?? 0)) * 0.5;
  const monthlyToRetirement =
    retirementGoalContribution + habitualSaving + (input.extraMonthly ?? 0);

  const stepUp = Math.min(profile.cashflow.annualIncomeGrowthPct, 0.1);
  const projectedCorpus = accumulate({
    startingCorpus: investable,
    monthlyContribution: monthlyToRetirement,
    annualReturn: input.expectedReturnPct,
    years: yearsToRetirement,
    stepUpPct: stepUp,
    skipMonths: input.skipMonths,
    shockPct: input.shockPct,
    shockYear: input.shockYear,
  });

  const requiredMonthly = requiredMonthlyContribution(
    corpusRequired,
    investable,
    input.expectedReturnPct,
    yearsToRetirement,
    stepUp,
  );

  // Drawdown: post-retirement portfolio is de-risked, so returns drop toward debt.
  const postRetirementReturn = Math.max(
    assumptions.expectedReturns.debt,
    input.expectedReturnPct - 0.03,
  );
  let corpus = projectedCorpus;
  let spend = targetAnnualSpend;
  let depletionAge: number | null = null;
  // Drawdown starts now for someone already past their retirement age -
  // counting from a retirement age in the past reported a depletion age
  // years too early (and, for a scenario lever, one before today).
  for (let age = Math.max(retirementAge, profile.age); age < 100; age++) {
    corpus = (corpus - spend) * (1 + postRetirementReturn);
    spend *= 1 + assumptions.inflationPct;
    if (corpus <= 0) {
      depletionAge = age;
      break;
    }
  }

  const assumptionList: Assumption[] = [
    {
      label: 'Retirement age',
      value: `${retirementAge} (${yearsToRetirement} years away)`,
      source: input.retirementAgeDelta ? 'user_input' : 'user_input',
    },
    {
      label: 'Spending to replace',
      value: `Today’s expenses of ${round(monthlyExpensesNow, 0).toLocaleString('en-US')}/month, inflated at ${(assumptions.inflationPct * 100).toFixed(1)}%/yr. EMIs assumed cleared before retirement.`,
      source: 'derived',
    },
    {
      label: 'Safe withdrawal rate',
      value: `${(assumptions.safeWithdrawalRatePct * 100).toFixed(1)}% of the corpus in year one, rising with inflation`,
      source: 'market_assumption',
    },
    {
      label: 'Accumulation return',
      value: `${(input.expectedReturnPct * 100).toFixed(1)}%/yr from the recommended allocation`,
      source: 'derived',
    },
    {
      label: 'Post-retirement return',
      value: `${(postRetirementReturn * 100).toFixed(1)}%/yr on a de-risked portfolio`,
      source: 'model_default',
    },
    ...(input.shockPct !== undefined && input.shockYear !== undefined
      ? [
          {
            label: 'Market shock',
            value: `${(input.shockPct * 100).toFixed(0)}% one-off drawdown in year ${input.shockYear}, with contributions continuing`,
            source: 'user_input' as const,
          },
        ]
      : []),
    {
      label: 'Assumed monthly saving',
      value: `${round(monthlyToRetirement, 0).toLocaleString('en-US')}/month towards retirement, stepped up ${(stepUp * 100).toFixed(0)}%/yr (retirement goals plus half of the free surplus)`,
      source: 'derived',
    },
  ];

  return {
    yearsToRetirement,
    targetAnnualSpend: round(targetAnnualSpend, 0),
    corpusRequired: round(corpusRequired, 0),
    projectedCorpus: round(projectedCorpus, 0),
    readinessRatio: round(corpusRequired > 0 ? projectedCorpus / corpusRequired : 1, 4),
    monthlyGap: round(Math.max(0, requiredMonthly - monthlyToRetirement), 0),
    depletionAge,
    plan: {
      startingCorpus: round(investable, 0),
      monthlyContribution: round(monthlyToRetirement, 0),
      stepUpPct: stepUp,
      years: yearsToRetirement,
      expectedReturnPct: round(input.expectedReturnPct, 4),
    },
    assumptions: assumptionList,
  };
}

/**
 * Debt payoff comparison. Avalanche orders by rate (mathematically optimal),
 * snowball by balance (psychologically easier). We show both and let the user
 * pick rather than pretending only one is correct.
 */
export function planDebtPayoff(
  profile: UserProfile,
  strategy: 'avalanche' | 'snowball',
  extraMonthly = 0,
): DebtPayoffPlan {
  const debts = profile.liabilities
    .filter((l) => l.outstanding > 0)
    .map((l) => ({ ...l, balance: l.outstanding }))
    .sort((a, b) =>
      strategy === 'avalanche'
        ? b.interestRatePct - a.interestRatePct
        : a.outstanding - b.outstanding,
    );

  const interestPaid = new Map<string, number>(debts.map((d) => [d.id, 0]));
  const payoffMonth = new Map<string, number>();
  const diverged = new Set<string>();
  const startingBalance = new Map<string, number>(debts.map((d) => [d.id, d.outstanding]));
  let month = 0;
  const MAX_MONTHS = 600;

  while (debts.some((d) => d.balance > 0.5 && !diverged.has(d.id)) && month < MAX_MONTHS) {
    month += 1;
    // Freed-up EMIs from cleared debts roll into the next target (the snowball).
    let snowball = extraMonthly + sum(debts.filter((d) => d.balance <= 0.5).map((d) => d.emi));

    for (const debt of debts) {
      if (debt.balance <= 0.5 || diverged.has(debt.id)) continue;
      const i = monthlyRate(debt.interestRatePct);
      const interest = debt.balance * i;
      const due = debt.balance + interest;
      /*
       * Never pay more than is owed. In a debt's final month the part of its
       * EMI it no longer needs rolls on to the next debt, and the extra only
       * tops up what the EMI leaves outstanding. Paying EMI + extra against the
       * full balance threw the surplus away every time a debt cleared - a
       * 5,000 EMI on a 100 balance lost 4,900 that month.
       */
      let payment = Math.min(debt.emi, due);
      snowball += debt.emi - payment;
      if (snowball > 0 && payment < due) {
        const extra = Math.min(snowball, due - payment);
        payment += extra;
        snowball -= extra;
      }
      /*
       * A payment that does not cover the interest means the balance grows, and
       * projecting that forward for 50 years produced a 1.6-quadrillion-rupee
       * interest figure that would have been rendered to a user verbatim.
       *
       * The debt is only declared unpayable once it has tripled, rather than on
       * the first month it fails to amortise - the snowball from other debts
       * clearing can still rescue it, and cutting it off early would hide a
       * plan that does eventually work.
       */
      const start = startingBalance.get(debt.id) ?? debt.balance;
      if (payment <= interest && debt.balance > start * 3) {
        diverged.add(debt.id);
        continue;
      }
      interestPaid.set(debt.id, (interestPaid.get(debt.id) ?? 0) + interest);
      debt.balance = debt.balance + interest - payment;
      if (debt.balance <= 0.5) {
        debt.balance = 0;
        payoffMonth.set(debt.id, month);
      }
    }
  }

  const unclearedIds = new Set(
    debts.filter((d) => d.balance > 0.5 || diverged.has(d.id)).map((d) => d.id),
  );

  const unpayable = debts
    .filter((d) => unclearedIds.has(d.id))
    .map((d) => {
      const start = startingBalance.get(d.id) ?? d.balance;
      const monthlyInterest = start * monthlyRate(d.interestRatePct);
      return {
        liabilityId: d.id,
        name: d.name,
        monthlyShortfall: round(Math.max(0, monthlyInterest - d.emi - extraMonthly), 0),
        interestRatePct: d.interestRatePct,
      };
    });

  const order = debts
    .filter((d) => !unclearedIds.has(d.id))
    .map((d) => ({
      liabilityId: d.id,
      name: d.name,
      payoffMonth: payoffMonth.get(d.id) ?? month,
      interestPaid: round(interestPaid.get(d.id) ?? 0, 0),
    }));

  return {
    strategy,
    /*
     * The month the last *clearable* debt is paid off, not the month the loop
     * gave up. Reporting the loop's exit month as a payoff date would claim a
     * debt-free date for a plan that never gets there; `clearsEverything` and
     * `unpayable` carry that news instead.
     */
    monthsToDebtFree: order.reduce((latest, d) => Math.max(latest, d.payoffMonth), 0),
    // Interest on a diverged debt is excluded: the figure would be dominated by
    // a balance the plan never actually pays down.
    totalInterestPaid: round(
      sum(debts.filter((d) => !diverged.has(d.id)).map((d) => interestPaid.get(d.id) ?? 0)),
      0,
    ),
    order,
    clearsEverything: unclearedIds.size === 0,
    unpayable,
  };
}

/**
 * Five-pillar wellness score. Weights are fixed and published in the UI so the
 * number is auditable - a black-box credit-score-style figure would undermine
 * the explainability the platform is built on.
 */
export function scoreWellness(
  profile: UserProfile,
  cashflow: CashflowSummary,
  assumptions: MarketAssumptions,
  diversificationScore: number,
  goalsOnTrack: number,
  goalsTotal: number,
  retirementReadiness: number,
): WellnessScore {
  const monthlyExpenses = cashflow.monthlyExpenses || 1;
  const annualIncome = cashflow.monthlyIncome * 12;

  /*
   * What the user has actually told us. A pillar computed from absent inputs is
   * reported as unscored rather than given a vacuous full mark - a 10x-income
   * life-cover rule is trivially "satisfied" when income is zero, and that
   * false pass used to flow straight into the headline grade.
   */
  const missing: string[] = [];
  const hasIncome = cashflow.monthlyIncome > 0;
  const hasExpenses = cashflow.monthlyExpenses > 0;
  const hasGoals = profile.goals.length > 0;
  const hasPortfolio = profile.holdings.length > 0 || profile.liquidSavings > 0;
  if (!hasIncome) missing.push('your monthly income');
  if (!hasExpenses) missing.push('your monthly spending');
  if (!hasGoals) missing.push('at least one goal');
  if (!hasPortfolio) missing.push('what you hold in savings or investments');

  // Protection: emergency fund plus insurance cover against a 10x income rule.
  const bufferScore = clamp((cashflow.emergencyFundMonths / assumptions.emergencyFundMonths) * 100, 0, 100);
  const lifeNeeded = annualIncome * 10;
  const lifeScore =
    lifeNeeded > 0 ? clamp(((profile.lifeInsuranceCover ?? 0) / lifeNeeded) * 100, 0, 100) : 0;
  /*
   * Scored against the same target the `close-health-cover-gap` rule uses, not
   * a second hardcoded multiple. This pillar used `annualIncome * 0.5`, which
   * silently ignored the age floor, the per-dependent loading, and any figure
   * the user had edited in the ledger - so raising the multiple changed the
   * action and left the score that grades it untouched.
   */
  const healthNeeded = hasIncome
    ? healthCoverTarget({
        annualIncome,
        age: profile.age,
        dependents: profile.dependents,
        assumptions,
      })
    : 0;
  const healthScore =
    healthNeeded > 0
      ? clamp(((profile.healthInsuranceCover ?? 0) / healthNeeded) * 100, 0, 100)
      : 0;
  const protection = bufferScore * 0.5 + lifeScore * 0.3 + healthScore * 0.2;

  // Cashflow: a 20% savings rate scores full marks.
  const cashflowScore = clamp((cashflow.savingsRatePct / 0.2) * 100, 0, 100);

  // Debt: DTI under 20% is healthy, over 50% is critical. High-APR debt is punished.
  const dtiScore = clamp(100 - Math.max(0, cashflow.debtToIncomeRatio - 0.2) * 260, 0, 100);
  const highCostDebt = sum(
    profile.liabilities.filter((l) => l.interestRatePct > 0.15).map((l) => l.outstanding),
  );
  const highCostPenalty = clamp((highCostDebt / (monthlyExpenses * 6 || 1)) * 40, 0, 60);
  const debt = clamp(dtiScore - highCostPenalty, 0, 100);

  const investing = clamp(diversificationScore, 0, 100);
  // With no goals and no expenses the required corpus is zero, which made the
  // readiness ratio a vacuous 1.0 and handed this pillar a full 100.
  const goals = goalsTotal > 0
    ? (goalsOnTrack / goalsTotal) * 70 + clamp(retirementReadiness * 30, 0, 30)
    : hasExpenses
      ? clamp(retirementReadiness * 100, 0, 100)
      : 0;

  const pillars: WellnessScore['pillars'] = [
    {
      name: 'Protection',
      score: round(protection, 0),
      weight: 0.25,
      scored: hasIncome && hasExpenses,
      summary: hasExpenses
        ? `${cashflow.emergencyFundMonths.toFixed(1)} months of expenses in reserve (target ${assumptions.emergencyFundMonths}); life cover ${((profile.lifeInsuranceCover ?? 0) / (annualIncome || 1)).toFixed(1)}x income.`
        : 'Needs your monthly spending before an emergency-fund target can be set.',
    },
    {
      name: 'Cashflow',
      score: round(cashflowScore, 0),
      weight: 0.2,
      scored: hasIncome,
      summary: hasIncome
        ? `Saving ${(cashflow.savingsRatePct * 100).toFixed(1)}% of income; a 20% rate scores full marks.`
        : 'Needs your monthly income.',
    },
    {
      name: 'Debt',
      score: round(debt, 0),
      weight: 0.2,
      scored: hasIncome,
      summary: hasIncome
        ? `EMIs are ${(cashflow.debtToIncomeRatio * 100).toFixed(0)}% of income${highCostDebt > 0 ? ', with high-interest debt outstanding' : ''}.`
        : 'Needs your income to judge whether any debt is affordable.',
    },
    {
      name: 'Investing',
      score: round(investing, 0),
      weight: 0.15,
      scored: hasPortfolio,
      summary: hasPortfolio
        ? `Diversification score ${diversificationScore}/100 across asset classes and individual positions.`
        : 'Nothing held yet, so there is nothing to diversify.',
    },
    {
      name: 'Goals',
      score: round(goals, 0),
      weight: 0.2,
      scored: hasGoals || hasExpenses,
      summary: hasGoals
        ? `${goalsOnTrack} of ${goalsTotal} goals fully funded on current behaviour; retirement ${(retirementReadiness * 100).toFixed(0)}% funded.`
        : hasExpenses
          ? `No goals set; retirement alone is ${(retirementReadiness * 100).toFixed(0)}% funded.`
          : 'Needs a goal, or your spending, to have anything to fund.',
    },
  ];

  const total = round(sum(pillars.map((p) => p.score * p.weight)), 0);
  const grade: WellnessScore['grade'] = total >= 80 ? 'A' : total >= 65 ? 'B' : total >= 45 ? 'C' : 'D';
  return {
    total,
    grade,
    pillars,
    dataComplete: pillars.every((p) => p.scored),
    missing,
  };
}
