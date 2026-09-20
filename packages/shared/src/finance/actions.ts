import {
  ASSET_LABELS,
  HEALTH_COVER_AGE_BANDS,
  healthCoverFloorForAge,
  healthCoverTarget,
} from '../assumptions.js';
import type {
  AllocationWeights,
  CashflowSummary,
  GoalProjection,
  MarketAssumptions,
  NextBestAction,
  PortfolioAnalysis,
  RetirementReadiness,
  RiskProfile,
  UserProfile,
} from '../types.js';
import { clamp, futureValueLumpSum, round, sum } from './math.js';

export interface ActionContext {
  profile: UserProfile;
  cashflow: CashflowSummary;
  portfolio: PortfolioAnalysis;
  risk: RiskProfile;
  recommendedAllocation: AllocationWeights;
  goalProjections: GoalProjection[];
  retirement: RetirementReadiness;
  assumptions: MarketAssumptions;
}

/**
 * Rule-based recommendation engine.
 *
 * Deliberately deterministic: the LLM *narrates and prioritises* these actions,
 * it does not invent them. That split is what makes the advice reproducible and
 * auditable - two users with the same balance sheet get the same actions, and
 * every action carries the arithmetic behind its impact figure.
 *
 * Ordering follows the standard financial-planning waterfall (protect, then
 * clear expensive debt, then fund goals, then optimise) rather than raw impact,
 * because a rupee of emergency fund is worth more than a rupee of alpha when
 * there is no buffer at all.
 */
export function generateActions(ctx: ActionContext): NextBestAction[] {
  const { profile, cashflow, portfolio, risk, goalProjections, retirement, assumptions } = ctx;
  const actions: NextBestAction[] = [];
  const currencyUnit = 'currency' as const;
  const expectedReturn = portfolio.expectedReturnPct || assumptions.expectedReturns.debt;

  /*
   * 0. A debt whose payment does not cover its own interest. -------------------
   *
   * This outranks everything, including the emergency fund: the balance is
   * growing every month, so every other plan is being made on a floor that is
   * still sinking. It is checked first rather than folded into the
   * expensive-debt rule because the required action is different - the point is
   * not "pay this off sooner", it is "your payment is too small to work at all".
   */
  for (const liability of profile.liabilities) {
    if (liability.outstanding <= 0) continue;
    const monthlyInterest = liability.outstanding * (Math.pow(1 + liability.interestRatePct, 1 / 12) - 1);
    if (liability.emi >= monthlyInterest) continue;
    const shortfall = monthlyInterest - liability.emi;
    actions.push({
      id: `cover-interest-${liability.id}`,
      title: `${liability.name} is growing, not shrinking`,
      category: 'debt',
      why: `At ${(liability.interestRatePct * 100).toFixed(1)}% a year, this balance accrues about ${fmt(monthlyInterest)} of interest a month, but you are paying ${fmt(liability.emi)}. The balance rises by ${fmt(shortfall)} every month no matter what else you do, so this comes before anything else in the plan.`,
      impact: {
        metric: 'Monthly balance growth stopped',
        value: round(shortfall, 0),
        unit: currencyUnit,
      },
      effort: 'high',
      // Deliberately above every other rule's ceiling.
      priorityScore: 100,
      steps: [
        `Raise the payment to at least ${fmt(monthlyInterest)} a month just to stop the balance growing.`,
        `To actually clear it, pay more than that - every rupee above ${fmt(monthlyInterest)} reduces the balance.`,
        'Ask the lender about restructuring, a lower rate, or a balance transfer before the balance compounds further.',
        'If the payment is genuinely unaffordable, seek debt counselling - this does not resolve itself.',
      ],
      assumptions: [
        { label: 'Outstanding balance', value: fmt(liability.outstanding), source: 'user_input' },
        {
          label: 'Interest rate',
          value: `${(liability.interestRatePct * 100).toFixed(1)}% APR, converted to a monthly rate geometrically`,
          source: 'user_input',
        },
        { label: 'Current payment', value: `${fmt(liability.emi)}/month`, source: 'user_input' },
        {
          label: 'Not modelled',
          value: 'Late fees, penalty rates and any impact on your credit record, all of which make this worse',
          source: 'model_default',
        },
      ],
      evidence: {
        [`${liability.name} outstanding`]: liability.outstanding,
        [`${liability.name} monthly interest`]: monthlyInterest,
        [`${liability.name} payment`]: liability.emi,
        [`${liability.name} monthly shortfall`]: shortfall,
        [`${liability.name} rate`]: liability.interestRatePct,
      },
    });
  }

  /* 1. Expensive debt beats every investment return. -------------------------- */
  const expensiveDebts = profile.liabilities
    .filter((l) => l.interestRatePct > expectedReturn && l.outstanding > 0)
    .sort((a, b) => b.interestRatePct - a.interestRatePct);
  const topDebt = expensiveDebts[0];
  if (topDebt) {
    const annualInterest = topDebt.outstanding * topDebt.interestRatePct;
    const spread = topDebt.interestRatePct - expectedReturn;
    actions.push({
      id: 'clear-expensive-debt',
      title: `Clear ${topDebt.name} before investing anything extra`,
      category: 'debt',
      why: `It costs ${(topDebt.interestRatePct * 100).toFixed(1)}% a year while your portfolio is only expected to earn ${(expectedReturn * 100).toFixed(1)}%. Paying it down is a guaranteed ${(spread * 100).toFixed(1)}% return, which no investment can promise.`,
      impact: { metric: 'Interest avoided per year', value: round(annualInterest, 0), unit: currencyUnit },
      effort: 'medium',
      priorityScore: clamp(70 + spread * 100, 70, 99),
      steps: [
        `Direct the whole monthly surplus of ${fmt(cashflow.monthlySurplus)} at this balance first.`,
        'Stop new spending on the account until the balance is zero.',
        `Check whether a lower-rate balance transfer or a secured loan can refinance the ${(topDebt.interestRatePct * 100).toFixed(1)}% rate.`,
        'Only then resume increasing investment contributions.',
      ],
      assumptions: [
        { label: 'Outstanding balance', value: fmt(topDebt.outstanding), source: 'user_input' },
        { label: 'Interest rate', value: `${(topDebt.interestRatePct * 100).toFixed(1)}% APR`, source: 'user_input' },
        {
          label: 'Comparison',
          value: `Portfolio expected return of ${(expectedReturn * 100).toFixed(1)}%, before tax`,
          source: 'derived',
        },
        {
          label: 'Interest figure',
          value: 'Simple annual interest on the current balance; actual interest falls as you repay',
          source: 'model_default',
        },
      ],
      evidence: {
        'debt outstanding': topDebt.outstanding,
        'debt interest rate': topDebt.interestRatePct,
        'portfolio expected return': expectedReturn,
        'guaranteed spread': spread,
        'monthly surplus': cashflow.monthlySurplus,
      },
    });
  }

  /* 2. Emergency fund - the foundation everything else rests on. -------------- */
  if (cashflow.emergencyFundGap > 0) {
    const monthsShort = assumptions.emergencyFundMonths - cashflow.emergencyFundMonths;
    const monthsToFill =
      cashflow.monthlySurplus > 0
        ? Math.ceil(cashflow.emergencyFundGap / cashflow.monthlySurplus)
        : null;
    const severity = clamp((monthsShort / assumptions.emergencyFundMonths) * 100, 0, 100);
    actions.push({
      id: 'build-emergency-fund',
      title:
        cashflow.emergencyFundMonths < 1
          ? 'Start an emergency fund before anything else'
          : `Top up the emergency fund by ${fmt(cashflow.emergencyFundGap)}`,
      category: 'protection',
      why: `You currently have ${cashflow.emergencyFundMonths.toFixed(1)} months of expenses in reserve. Without ${assumptions.emergencyFundMonths} months, one job gap or medical event forces you to sell investments at the worst possible time or borrow at a high rate.`,
      impact: {
        metric: 'Months of expenses covered',
        value: round(monthsShort, 1),
        unit: 'months',
      },
      effort: 'low',
      priorityScore: clamp(60 + severity * 0.35, 55, 96),
      steps: [
        `Move ${fmt(cashflow.emergencyFundGap)} into a liquid fund or sweep-in deposit${monthsToFill ? ` - about ${monthsToFill} months at your current surplus` : ''}.`,
        'Keep it separate from your spending account so it does not get used by accident.',
        'Automate the transfer for the day after payday.',
      ],
      assumptions: [
        {
          label: 'Monthly expenses',
          value: `${fmt(cashflow.monthlyExpenses)}/month`,
          source: 'user_input',
        },
        {
          label: 'Target buffer',
          value: `${assumptions.emergencyFundMonths} months = ${fmt(cashflow.emergencyFundTarget)}`,
          source: 'market_assumption',
        },
        { label: 'Current liquid savings', value: fmt(profile.liquidSavings), source: 'user_input' },
      ],
      evidence: {
        'emergency fund gap': cashflow.emergencyFundGap,
        'emergency fund target': cashflow.emergencyFundTarget,
        'emergency fund months': cashflow.emergencyFundMonths,
        'target buffer months': assumptions.emergencyFundMonths,
        'monthly expenses': cashflow.monthlyExpenses,
        ...(monthsToFill ? { 'months to fill the gap': monthsToFill } : {}),
      },
      apply: { type: 'set_emergency_fund', amount: round(cashflow.emergencyFundTarget, 0) },
    });
  }

  /* 3. Protection gaps. ------------------------------------------------------- */
  const annualIncome = cashflow.monthlyIncome * 12;
  const lifeNeed = annualIncome * 10;
  const lifeCover = profile.lifeInsuranceCover ?? 0;
  if (profile.dependents > 0 && lifeCover < lifeNeed * 0.8) {
    actions.push({
      id: 'close-life-cover-gap',
      title: `Increase life cover by ${fmt(lifeNeed - lifeCover)}`,
      category: 'protection',
      why: `With ${profile.dependents} dependent(s) and ${fmt(annualIncome)} of annual income, a 10x cover rule implies ${fmt(lifeNeed)}. You hold ${fmt(lifeCover)}, so your family would be short if your income stopped permanently.`,
      impact: { metric: 'Protection gap closed', value: round(lifeNeed - lifeCover, 0), unit: currencyUnit },
      effort: 'low',
      priorityScore: 78,
      steps: [
        `Get quotes for a pure term policy of ${fmt(lifeNeed - lifeCover)} to age ${Math.max(60, profile.retirementAge)}.`,
        'Choose term insurance, not a savings-linked plan - the premium is a fraction of the cost for the same cover.',
        'Disclose medical history fully so the claim cannot be contested later.',
      ],
      assumptions: [
        { label: 'Cover rule', value: '10x annual income, a common planning heuristic', source: 'model_default' },
        { label: 'Existing cover', value: fmt(lifeCover), source: 'user_input' },
        {
          label: 'Not modelled',
          value: 'Existing employer cover, spouse income and liabilities that would need clearing',
          source: 'model_default',
        },
      ],
      evidence: {
        'life cover needed': lifeNeed,
        'life cover held': lifeCover,
        'life cover gap': lifeNeed - lifeCover,
        'annual income': annualIncome,
      },
    });
  }

  /*
   * 3b. Health cover. ---------------------------------------------------------
   *
   * Immediately after life cover, and for the same reason: an uninsured medical
   * event is the fastest way a funded plan stops being one. It ranks below life
   * cover because a death with dependents and no cover is unrecoverable, where
   * a medical event is survivable but expensive - and it ranks above every goal
   * and optimisation rule because the money it protects is the emergency fund
   * those rules quietly assume is there.
   */
  const healthCoverTargetAmount = healthCoverTarget({
    annualIncome,
    age: profile.age,
    dependents: profile.dependents,
    assumptions,
  });
  const healthCover = profile.healthInsuranceCover ?? 0;
  const healthGap = healthCoverTargetAmount - healthCover;
  if (healthGap > 0) {
    const ageFloor = healthCoverFloorForAge(profile.age, assumptions);
    const dependentLoading = profile.dependents * assumptions.healthCoverPerDependent;
    /*
     * The knock-on nobody prices in: an uncovered admission is paid out of the
     * emergency fund, so the buffer that rule 2 sized against job loss has to
     * absorb a medical bill as well. Stating the implied target is what turns
     * "you are under-insured" into a number the user can act on.
     */
    const emergencyTargetIfUninsured = cashflow.emergencyFundTarget + healthGap;
    const monthsOfExpensesExposed =
      cashflow.monthlyExpenses > 0 ? healthGap / cashflow.monthlyExpenses : 0;

    /*
     * Urgency has three drivers and the weights are chosen so none of them can
     * be masked: at their joint maximum (a total gap, three or more dependents,
     * no cover at all) the score reaches 76.1, still under the life-cover rule's
     * 78. An earlier cut used wider weights and a clamp, which made "no cover,
     * two dependents" and "no cover, none" score identically at the ceiling -
     * the dependent signal existed in the arithmetic and never reached the user.
     */
    const severity = clamp(healthGap / healthCoverTargetAmount, 0, 1);
    const dependentUrgency = Math.min(profile.dependents, 3) * 1.2;
    const uninsuredUrgency = healthCover <= 0 ? 2.5 : 0;

    actions.push({
      id: 'close-health-cover-gap',
      title:
        healthCover <= 0
          ? `Take out health cover of ${fmt(healthCoverTargetAmount)} - you have none`
          : `Raise health cover by ${fmt(healthGap)}`,
      category: 'protection',
      why: `${
        healthCover <= 0
          ? 'You hold no health cover at all.'
          : `You hold ${fmt(healthCover)} of health cover.`
      } At ${profile.age} with ${fmt(annualIncome)} of annual income${
        profile.dependents > 0 ? ` and ${profile.dependents} dependent(s)` : ''
      }, the model puts the target at ${fmt(healthCoverTargetAmount)}, leaving ${fmt(healthGap)} you would have to find yourself. That is ${monthsOfExpensesExposed.toFixed(1)} months of your expenses, and it would come out of the emergency fund - which is why an uninsured household effectively needs ${fmt(emergencyTargetIfUninsured)} in reserve rather than ${fmt(cashflow.emergencyFundTarget)}.`,
      impact: {
        metric: 'Out-of-pocket exposure removed',
        value: round(healthGap, 0),
        unit: currencyUnit,
      },
      effort: 'low',
      // Bounded below the life-cover rule's 78 so the protection waterfall holds.
      priorityScore: round(
        clamp(66 + severity * 4 + dependentUrgency + uninsuredUrgency, 66, 77),
        1,
      ),
      steps: [
        healthCover <= 0
          ? `Get quotes for a ${fmt(healthCoverTargetAmount)} family floater before anything else in this list below it.`
          : `Add ${fmt(healthGap)} of cover - a top-up or super top-up over your existing ${fmt(healthCover)} is usually far cheaper than replacing the base policy.`,
        'Check what your employer policy actually covers. It typically ends with the job, which is exactly when you can least afford to replace it.',
        'Read the sub-limits, not the headline number: room-rent caps, co-pay and disease-specific limits decide what a claim really pays.',
        'Disclose pre-existing conditions fully. A contested claim is the same as no cover.',
        ...(profile.dependents > 0
          ? ['Cover dependents on the same floater rather than separate small policies - one larger pool absorbs a bad year better.']
          : []),
      ],
      assumptions: [
        {
          label: 'Cover rule',
          value: `The higher of ${assumptions.healthCoverIncomeMultiple}x annual income (${fmt(annualIncome * assumptions.healthCoverIncomeMultiple)}) and the age ${profile.age} floor (${fmt(ageFloor)})`,
          source: 'market_assumption',
        },
        {
          label: 'Age bands',
          value: `Floors step up under ${HEALTH_COVER_AGE_BANDS.youngMaxAge}, ${HEALTH_COVER_AGE_BANDS.youngMaxAge}-${HEALTH_COVER_AGE_BANDS.midMaxAge} and above ${HEALTH_COVER_AGE_BANDS.midMaxAge}`,
          source: 'model_default',
        },
        {
          label: 'Dependent loading',
          value: `${fmt(assumptions.healthCoverPerDependent)} per dependent x ${profile.dependents} = ${fmt(dependentLoading)}`,
          source: 'market_assumption',
        },
        { label: 'Existing cover', value: fmt(healthCover), source: 'user_input' },
        {
          label: 'Knock-on effect',
          value: `An uncovered event is paid from savings, so the emergency-fund target rises from ${fmt(cashflow.emergencyFundTarget)} to ${fmt(emergencyTargetIfUninsured)} while the gap is open`,
          source: 'derived',
        },
        {
          label: 'Not modelled',
          value:
            'Premium cost, employer group cover, waiting periods on pre-existing conditions, room-rent caps, co-pay and disease sub-limits',
          source: 'model_default',
        },
      ],
      evidence: {
        'health cover needed': healthCoverTargetAmount,
        'health cover held': healthCover,
        'health cover gap': healthGap,
        'health cover age floor': ageFloor,
        'health cover income component': annualIncome * assumptions.healthCoverIncomeMultiple,
        'health cover dependent loading': dependentLoading,
        'annual income': annualIncome,
        'months of expenses exposed': monthsOfExpensesExposed,
        'emergency fund target': cashflow.emergencyFundTarget,
        'emergency fund target if uninsured': emergencyTargetIfUninsured,
      },
    });
  }

  /* 4. Goal gaps, biggest first. --------------------------------------------- */
  const offTrack = goalProjections
    .filter((g) => !g.onTrack && g.monthlyGap > 0)
    .sort((a, b) => {
      const priorityRank = { must_have: 0, important: 1, aspirational: 2 } as const;
      const ga = profile.goals.find((x) => x.id === a.goalId);
      const gb = profile.goals.find((x) => x.id === b.goalId);
      const pa = priorityRank[ga?.priority ?? 'important'];
      const pb = priorityRank[gb?.priority ?? 'important'];
      if (pa !== pb) return pa - pb;
      return b.monthlyGap - a.monthlyGap;
    })
    .slice(0, 3);

  for (const g of offTrack) {
    const goal = profile.goals.find((x) => x.id === g.goalId);
    const affordable = cashflow.monthlySurplus >= g.monthlyGap;
    const stepUpAlternative = goal && goal.contributionStepUpPct < 0.1;
    actions.push({
      id: `fund-goal-${g.goalId}`,
      title: `Add ${fmt(g.monthlyGap)}/month to "${g.goalName}"`,
      category: 'goals',
      why: `On today's contribution this goal reaches ${fmt(g.projectedCorpus)} against a ${fmt(g.inflatedTarget)} target in ${g.yearsToGoal.toFixed(1)} years - a ${fmt(Math.abs(g.surplus))} shortfall. ${
        affordable
          ? `Your surplus of ${fmt(cashflow.monthlySurplus)} covers this.`
          : cashflow.monthlySurplus < 0
            ? `Your commitments already exceed your income by ${fmt(Math.abs(cashflow.monthlySurplus))} a month, so this gap cannot be closed with contributions alone - the timeline or the target has to move.`
            : `That is more than your ${fmt(cashflow.monthlySurplus)} surplus, so it needs a longer timeline or a smaller target.`
      }`,
      impact: { metric: 'Shortfall closed', value: round(Math.abs(g.surplus), 0), unit: currencyUnit },
      effort: affordable ? 'low' : 'high',
      priorityScore: clamp(
        (goal?.priority === 'must_have' ? 72 : goal?.priority === 'important' ? 58 : 40) +
          (1 - g.fundedRatio) * 20,
        30,
        92,
      ),
      steps: [
        `Increase the monthly contribution from ${fmt(goal?.monthlyContribution ?? 0)} to ${fmt(g.requiredMonthly)}.`,
        ...(stepUpAlternative
          ? [
              `Alternatively, keep the contribution as-is but step it up 10% every year with your salary - that closes most of the gap without changing your budget today.`,
            ]
          : []),
        ...(affordable
          ? []
          : [
              `Or push the target year from ${goal?.targetYear} to later, or reduce the target from ${fmt(goal?.targetAmountToday ?? 0)}.`,
            ]),
        `The required return route needs ${g.requiredReturnPct === null ? 'a return no reasonable portfolio delivers' : `${(g.requiredReturnPct * 100).toFixed(1)}%/yr`} - do not chase it.`,
      ],
      assumptions: g.assumptions,
      evidence: {
        [`${g.goalName} monthly gap`]: g.monthlyGap,
        [`${g.goalName} required monthly`]: g.requiredMonthly,
        [`${g.goalName} projected corpus`]: g.projectedCorpus,
        [`${g.goalName} inflated target`]: g.inflatedTarget,
        [`${g.goalName} shortfall`]: Math.abs(g.surplus),
        [`${g.goalName} current contribution`]: goal?.monthlyContribution ?? 0,
        [`${g.goalName} years`]: g.yearsToGoal,
        'monthly surplus': cashflow.monthlySurplus,
        ...(g.requiredReturnPct !== null
          ? { [`${g.goalName} required return`]: g.requiredReturnPct }
          : {}),
      },
      apply: { type: 'increase_goal_contribution', goalId: g.goalId, amount: round(g.monthlyGap, 0) },
    });
  }

  /* 5. Cash drag - money sitting still. -------------------------------------- */
  const excessCash = profile.liquidSavings - cashflow.emergencyFundTarget;
  if (excessCash > cashflow.monthlyExpenses) {
    const years = 10;
    const inCash = futureValueLumpSum(excessCash, assumptions.expectedReturns.cash, years);
    const invested = futureValueLumpSum(excessCash, expectedReturn, years);
    actions.push({
      id: 'deploy-idle-cash',
      title: `Put ${fmt(excessCash)} of idle cash to work`,
      category: 'investing',
      why: `You hold ${fmt(profile.liquidSavings)} in cash but only need ${fmt(cashflow.emergencyFundTarget)} as a buffer. The surplus is earning about ${(assumptions.expectedReturns.cash * 100).toFixed(1)}% while inflation runs at ${(assumptions.inflationPct * 100).toFixed(1)}% - it is losing purchasing power every month.`,
      impact: {
        metric: `Extra value over ${years} years`,
        value: round(invested - inCash, 0),
        unit: currencyUnit,
      },
      effort: 'low',
      priorityScore: clamp(45 + (excessCash / (cashflow.monthlyExpenses || 1)) * 2, 45, 80),
      steps: [
        `Keep ${fmt(cashflow.emergencyFundTarget)} liquid and invest the remaining ${fmt(excessCash)}.`,
        `Deploy it into your ${risk.bucket} target mix over 3-6 monthly tranches rather than all at once, to avoid buying a single bad day.`,
        'Point it at the goal with the largest shortfall first.',
      ],
      assumptions: [
        {
          label: 'Cash return',
          value: `${(assumptions.expectedReturns.cash * 100).toFixed(1)}%/yr vs ${(expectedReturn * 100).toFixed(1)}% invested`,
          source: 'market_assumption',
        },
        { label: 'Horizon', value: `${years} years, nominal, pre-tax`, source: 'model_default' },
        {
          label: 'Not modelled',
          value: 'Capital gains tax on redemption and any short-term cash needs you have not entered',
          source: 'model_default',
        },
      ],
      evidence: {
        'idle cash': excessCash,
        'liquid savings': profile.liquidSavings,
        'emergency fund target': cashflow.emergencyFundTarget,
        'cash return': assumptions.expectedReturns.cash,
        'invested return': expectedReturn,
        inflation: assumptions.inflationPct,
        'value forgone': invested - inCash,
      },
      apply: { type: 'set_allocation', weights: ctx.recommendedAllocation },
    });
  }

  /* 6. Allocation mismatch against the risk profile. ------------------------- */
  const currentEquity =
    (portfolio.weights.equity_domestic ?? 0) +
    (portfolio.weights.equity_international ?? 0) +
    (portfolio.weights.reit ?? 0);
  const targetEquity =
    (ctx.recommendedAllocation.equity_domestic ?? 0) +
    (ctx.recommendedAllocation.equity_international ?? 0) +
    (ctx.recommendedAllocation.reit ?? 0);
  const equityGap = targetEquity - currentEquity;
  if (Math.abs(equityGap) > 0.1) {
    const tooLow = equityGap > 0;
    const returnDelta = Math.abs(
      (targetEquity - currentEquity) *
        (assumptions.expectedReturns.equity_domestic - assumptions.expectedReturns.debt),
    );
    actions.push({
      id: 'align-allocation',
      title: tooLow
        ? `Raise equity from ${(currentEquity * 100).toFixed(0)}% to ${(targetEquity * 100).toFixed(0)}%`
        : `Reduce equity from ${(currentEquity * 100).toFixed(0)}% to ${(targetEquity * 100).toFixed(0)}%`,
      category: 'investing',
      why: tooLow
        ? `Your ${risk.bucket} profile and ${retirement.yearsToRetirement}-year horizon support more growth assets than you hold. Being under-invested in equity is a real cost, not a safe choice, over this timeframe.`
        : `You hold more equity than your ${risk.bucket} profile supports. With ${retirement.yearsToRetirement} years to retirement, a deep drawdown at the wrong moment would be difficult to recover from.`,
      impact: {
        metric: tooLow ? 'Expected return added' : 'Volatility removed',
        value: round(returnDelta * 100, 2),
        unit: 'percent',
      },
      effort: 'medium',
      priorityScore: clamp(50 + Math.abs(equityGap) * 100, 50, 85),
      steps: [
        `Shift roughly ${fmt(Math.abs(equityGap) * portfolio.totalValue)} ${tooLow ? 'into' : 'out of'} equity.`,
        'Do it with new contributions first - that avoids triggering capital gains.',
        'Spread any large switch over a few months.',
      ],
      assumptions: [
        {
          label: 'Risk assessment',
          value: `${risk.bucket} - tolerance ${risk.toleranceScore}/100, capacity ${risk.capacityScore}/100`,
          source: 'derived',
        },
        {
          label: 'Glide path',
          value: `Model portfolio for ${risk.bucket}, de-risked for a ${retirement.yearsToRetirement}-year horizon`,
          source: 'model_default',
        },
      ],
      evidence: {
        'current equity share': currentEquity,
        'target equity share': targetEquity,
        'equity gap': Math.abs(equityGap),
        'amount to shift': Math.abs(equityGap) * portfolio.totalValue,
        'return impact': returnDelta,
      },
      apply: { type: 'set_allocation', weights: ctx.recommendedAllocation },
    });
  }

  /* 7. Single-name concentration - securities only, never funds or deposits. -- */
  if (portfolio.largestSingleSecurity && portfolio.largestSingleSecurity.weight > 0.15) {
    const weight = portfolio.largestSingleSecurity.weight;
    const trimTo = 0.1;
    actions.push({
      id: 'reduce-concentration',
      title: `Trim ${portfolio.largestSingleSecurity.name} from ${(weight * 100).toFixed(0)}% to ${(trimTo * 100).toFixed(0)}%`,
      category: 'investing',
      why: `One individual security is ${(weight * 100).toFixed(0)}% of your invested assets. That is company-specific risk you are not compensated for - if it falls 50%, your whole portfolio drops ${(weight * 50).toFixed(0)}%, and a diversified fund would have given you the same expected return without it.`,
      impact: {
        metric: 'Single-name exposure reduced',
        value: round((weight - trimTo) * 100, 1),
        unit: 'percent',
      },
      effort: 'medium',
      priorityScore: clamp(48 + (weight - 0.15) * 160, 48, 88),
      steps: [
        `Sell down to ${(trimTo * 100).toFixed(0)}% and spread the proceeds across a broad index fund.`,
        'Stagger the sales across tax years if the gains are large.',
        'If it is employer stock, remember your salary is already exposed to the same company - a bad year hits your income and your portfolio together.',
      ],
      assumptions: [
        {
          label: 'Concentration measure',
          value: `Largest single security is ${(weight * 100).toFixed(1)}% of invested assets; ${portfolio.effectivePositions} effective positions across ${profile.holdings.length} holdings`,
          source: 'derived',
        },
        {
          label: 'Comfort threshold',
          value: 'No single security above 10-15% of invested assets. Funds and provident-fund balances are excluded - they are diversified internally.',
          source: 'model_default',
        },
      ],
      evidence: {
        'largest single security weight': weight,
        'target weight': trimTo,
        'portfolio drop if it halves': weight * 0.5,
        'effective positions': portfolio.effectivePositions,
      },
    });
  }

  /* 8. Drift. ---------------------------------------------------------------- */
  if (portfolio.totalDriftPct > 10) {
    const biggest = portfolio.drift
      .slice()
      .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct))[0];
    actions.push({
      id: 'rebalance-portfolio',
      title: `Rebalance - ${portfolio.totalDriftPct.toFixed(0)}% of your portfolio is out of position`,
      category: 'efficiency',
      why: `${biggest ? `${ASSET_LABELS[biggest.assetClass]} is ${(Math.abs(biggest.deltaPct) * 100).toFixed(0)} points ${biggest.deltaPct > 0 ? 'above' : 'below'} target. ` : ''}Drift means your actual risk no longer matches the plan you agreed to - usually because the winners grew into an oversized share.`,
      impact: { metric: 'Share of portfolio realigned', value: portfolio.totalDriftPct, unit: 'percent' },
      effort: 'low',
      priorityScore: clamp(40 + portfolio.totalDriftPct, 40, 78),
      steps: [
        ...portfolio.rebalanceTrades
          .slice(0, 4)
          .map((t) => `${t.action === 'buy' ? 'Buy' : 'Sell'} ${fmt(t.amount)} of ${ASSET_LABELS[t.assetClass]}.`),
        'Rebalance once or twice a year, or when any class drifts more than 5 points - not on every wobble.',
      ],
      assumptions: [
        {
          label: 'Drift measure',
          value:
            'Half the sum of absolute differences from target - i.e. the share of the portfolio that has to change hands, which cannot exceed 100%',
          source: 'model_default',
        },
        { label: 'Not modelled', value: 'Transaction costs, exit loads and capital gains tax', source: 'model_default' },
      ],
      evidence: {
        'total drift': portfolio.totalDriftPct,
        ...(biggest ? { 'largest class drift': Math.abs(biggest.deltaPct) } : {}),
        ...Object.fromEntries(
          portfolio.rebalanceTrades.slice(0, 4).map((t) => [`${t.action} ${t.assetClass}`, t.amount]),
        ),
      },
      apply: { type: 'rebalance_to_target' },
    });
  }

  /* 9. Fee drag. ------------------------------------------------------------- */
  if (portfolio.blendedExpenseRatioPct > 0.006 && portfolio.totalValue > 0) {
    const targetFee = 0.002;
    const saving = (portfolio.blendedExpenseRatioPct - targetFee) * portfolio.totalValue;
    const years = 20;
    const compounded =
      saving * ((Math.pow(1 + expectedReturn, years) - 1) / (expectedReturn || 0.01));
    actions.push({
      id: 'cut-fund-fees',
      title: `Cut fund costs from ${(portfolio.blendedExpenseRatioPct * 100).toFixed(2)}% to about ${(targetFee * 100).toFixed(2)}%`,
      category: 'efficiency',
      why: `You are paying roughly ${fmt(saving + targetFee * portfolio.totalValue)} a year in fund expenses. Fees are the only return driver you control with certainty, and they compound against you exactly like returns compound for you.`,
      impact: { metric: `Value retained over ${years} years`, value: round(compounded, 0), unit: currencyUnit },
      effort: 'low',
      priorityScore: clamp(35 + portfolio.blendedExpenseRatioPct * 3000, 35, 72),
      steps: [
        'List each holding with its expense ratio and find an index equivalent for the expensive ones.',
        'Switch the high-cost funds where the tax cost of switching is low or nil.',
        'Use direct plans rather than regular plans where you are not paying for advice.',
      ],
      assumptions: [
        {
          label: 'Current blended fee',
          value: `${(portfolio.blendedExpenseRatioPct * 100).toFixed(2)}%, weighted by holding value`,
          source: 'derived',
        },
        { label: 'Target fee', value: `${(targetFee * 100).toFixed(2)}% for broad index funds`, source: 'model_default' },
        {
          label: 'Projection',
          value: `Annual saving reinvested at ${(expectedReturn * 100).toFixed(1)}% for ${years} years`,
          source: 'derived',
        },
      ],
      evidence: {
        'blended expense ratio': portfolio.blendedExpenseRatioPct,
        'target expense ratio': targetFee,
        'annual fee saving': saving,
        'annual fees paid': saving + targetFee * portfolio.totalValue,
        'value retained': compounded,
      },
    });
  }

  /* 10. Step-up: the highest-leverage habit change available. ---------------- */
  const flatGoals = profile.goals.filter((g) => g.contributionStepUpPct < 0.05 && g.monthlyContribution > 0);
  if (flatGoals.length > 0 && profile.cashflow.annualIncomeGrowthPct > 0.05) {
    const totalContribution = sum(flatGoals.map((g) => g.monthlyContribution));
    const years = Math.max(5, retirement.yearsToRetirement);
    // Extra corpus from a 10% annual step-up versus a flat contribution.
    const flatFactor = stepFactor(expectedReturn, years, 0);
    const steppedFactor = stepFactor(expectedReturn, years, 0.1);
    const extra = totalContribution * (steppedFactor - flatFactor);
    actions.push({
      id: 'enable-step-up',
      title: 'Step up your contributions 10% every year',
      category: 'savings',
      why: `Your income is growing about ${(profile.cashflow.annualIncomeGrowthPct * 100).toFixed(0)}% a year but ${flatGoals.length} of your contributions are flat. Raising them with your salary costs nothing today and is the single largest lever you have, because the increases compound for decades.`,
      impact: {
        metric: `Extra corpus in ${years} years`,
        value: round(extra, 0),
        unit: currencyUnit,
      },
      effort: 'low',
      priorityScore: 66,
      steps: [
        `Set a 10% annual step-up on contributions totalling ${fmt(totalContribution)}/month.`,
        'Diarise it for the month after your appraisal so the raise is absorbed before you adjust to it.',
        'Most platforms can automate the step-up so you only decide once.',
      ],
      assumptions: [
        {
          label: 'Step-up modelled',
          value: `10%/yr against your ${(profile.cashflow.annualIncomeGrowthPct * 100).toFixed(0)}% income growth`,
          source: 'model_default',
        },
        { label: 'Horizon', value: `${years} years at ${(expectedReturn * 100).toFixed(1)}%/yr`, source: 'derived' },
      ],
      evidence: {
        'step-up modelled': 0.1,
        'income growth': profile.cashflow.annualIncomeGrowthPct,
        'flat contributions': totalContribution,
        'extra corpus from stepping up': extra,
        'horizon years': years,
      },
    });
  }

  /* 11. Retirement gap. ------------------------------------------------------ */
  if (retirement.readinessRatio < 0.9 && retirement.monthlyGap > 0) {
    actions.push({
      id: 'close-retirement-gap',
      title: `Add ${fmt(retirement.monthlyGap)}/month towards retirement`,
      category: 'goals',
      why: `On current saving you reach ${fmt(retirement.projectedCorpus)} against the ${fmt(retirement.corpusRequired)} needed to fund ${fmt(retirement.targetAnnualSpend)} a year from age ${profile.retirementAge}${retirement.depletionAge ? `. As it stands the money would run out around age ${retirement.depletionAge}` : ''}.`,
      impact: {
        metric: 'Retirement funding gap',
        value: round(retirement.corpusRequired - retirement.projectedCorpus, 0),
        unit: currencyUnit,
      },
      effort: retirement.monthlyGap <= Math.max(0, cashflow.monthlySurplus) ? 'medium' : 'high',
      priorityScore: clamp(55 + (1 - retirement.readinessRatio) * 30, 45, 90),
      steps: [
        `Increase long-term investing by ${fmt(retirement.monthlyGap)}/month.`,
        `Or work ${Math.min(5, Math.ceil((1 - retirement.readinessRatio) * 10))} more years - delaying retirement shortens the drawdown and lengthens the accumulation, so it moves the number twice.`,
        'Or plan to spend less in retirement - a 10% lower spend cuts the required corpus by 10%.',
        'Use the Scenario Lab to see which of these three you can actually live with.',
      ],
      assumptions: retirement.assumptions,
      evidence: {
        'retirement monthly gap': retirement.monthlyGap,
        'retirement projected corpus': retirement.projectedCorpus,
        'retirement corpus required': retirement.corpusRequired,
        'retirement funding gap': retirement.corpusRequired - retirement.projectedCorpus,
        'retirement annual spend': retirement.targetAnnualSpend,
        'retirement readiness': retirement.readinessRatio,
        ...(retirement.depletionAge ? { 'depletion age': retirement.depletionAge } : {}),
      },
    });
  }

  /* 12. Unallocated surplus. ------------------------------------------------- */
  if (cashflow.monthlySurplus > cashflow.monthlyIncome * 0.05 && !expensiveDebts.length && cashflow.emergencyFundGap === 0) {
    const years = Math.max(5, retirement.yearsToRetirement);
    const value = cashflow.monthlySurplus * stepFactor(expectedReturn, years, 0.05);
    actions.push({
      id: 'automate-surplus',
      title: `Automate ${fmt(cashflow.monthlySurplus)}/month of unallocated surplus`,
      category: 'savings',
      why: `You have ${fmt(cashflow.monthlySurplus)} a month that is not committed to any goal. Money without a job tends to get spent - automating it on payday removes the decision.`,
      impact: { metric: `Corpus built in ${years} years`, value: round(value, 0), unit: currencyUnit },
      effort: 'low',
      priorityScore: 52,
      steps: [
        `Set up an automatic monthly investment of ${fmt(cashflow.monthlySurplus)} dated for the day after payday.`,
        `Invest it in your ${risk.bucket} target mix.`,
        'Attach it to a named goal - funded goals get abandoned far less often than "investing in general".',
      ],
      assumptions: [
        { label: 'Surplus', value: `${fmt(cashflow.monthlySurplus)}/month after expenses, EMIs and existing goals`, source: 'derived' },
        { label: 'Projection', value: `${(expectedReturn * 100).toFixed(1)}%/yr with a 5% annual step-up over ${years} years`, source: 'derived' },
      ],
      evidence: {
        'monthly surplus': cashflow.monthlySurplus,
        'corpus built': value,
        'horizon years': years,
        'assumed return': expectedReturn,
      },
    });
  }

  /* 13. Tax efficiency - flagged clearly as illustrative. -------------------- */
  const taxAdvantaged = 150000;
  const currentLongTerm = sum(profile.goals.filter((g) => g.kind === 'retirement').map((g) => g.monthlyContribution)) * 12;
  if (profile.currency === 'INR' && currentLongTerm < taxAdvantaged && annualIncome > 500000) {
    const unused = taxAdvantaged - currentLongTerm;
    const marginalRate = annualIncome > 1500000 ? 0.3 : annualIncome > 1200000 ? 0.2 : 0.1;
    actions.push({
      id: 'use-tax-deduction',
      title: `Use the remaining ${fmt(unused)} of tax-deductible investment room`,
      category: 'tax',
      why: `Long-term investments that qualify for deduction are capped at ${fmt(taxAdvantaged)} a year and you are using ${fmt(currentLongTerm)}. The unused room is a one-time-per-year opportunity - it does not carry forward.`,
      impact: { metric: 'Estimated tax saved this year', value: round(unused * marginalRate, 0), unit: currencyUnit },
      effort: 'low',
      priorityScore: 47,
      steps: [
        `Route ${fmt(unused / 12)}/month of your existing long-term investing into a deduction-eligible instrument.`,
        'Prefer instruments you would have bought anyway - do not let the tax break drive a bad investment.',
        'Complete it before the financial year ends, not in a March rush.',
      ],
      assumptions: [
        { label: 'Deduction cap', value: `${fmt(taxAdvantaged)}/yr, old-regime Section 80C`, source: 'model_default' },
        { label: 'Assumed marginal rate', value: `${(marginalRate * 100).toFixed(0)}%, estimated from income`, source: 'derived' },
        {
          label: 'Important',
          value: 'Illustrative only. The benefit depends on your regime choice and full return - confirm with a tax adviser.',
          source: 'model_default',
        },
      ],
      evidence: {
        'deduction cap': taxAdvantaged,
        'deduction used': currentLongTerm,
        'deduction unused': unused,
        'marginal rate': marginalRate,
        'monthly amount to route': unused / 12,
        'tax saved': unused * marginalRate,
      },
    });
  }

  return actions.sort((a, b) => b.priorityScore - a.priorityScore);
}

/** FV of a unit monthly contribution with an annual step-up, in whole years. */
function stepFactor(annualReturn: number, years: number, stepUp: number): number {
  const i = Math.pow(1 + annualReturn, 1 / 12) - 1;
  const months = Math.round(years * 12);
  let factor = 0;
  for (let m = 0; m < months; m++) {
    const yearIdx = Math.floor(m / 12);
    factor += Math.pow(1 + stepUp, yearIdx) * Math.pow(1 + i, months - m - 1);
  }
  return factor;
}

/** Compact, currency-symbol-free formatting for explanation strings. */
function fmt(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(1)}k`;
  return `${sign}${abs.toFixed(0)}`;
}
