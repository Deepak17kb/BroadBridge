import { RISK_QUESTIONS } from '../assumptions.js';
import type { RiskAnswers, RiskBucket, RiskProfile, UserProfile } from '../types.js';
import { clamp, round } from './math.js';

function bucketFor(score: number): RiskBucket {
  if (score < 25) return 'Conservative';
  if (score < 45) return 'Moderate';
  if (score < 65) return 'Balanced';
  if (score < 82) return 'Growth';
  return 'Aggressive';
}

/**
 * Two-axis risk profiling.
 *
 * Tolerance comes from the questionnaire alone - it is a statement about
 * behaviour. Capacity blends the questionnaire's capacity items with hard facts
 * from the balance sheet (horizon, emergency buffer, dependents, income
 * stability, debt load), because a user can *say* they are brave while having
 * three months of runway and a 42% credit-card balance.
 *
 * The recommendation always uses min(tolerance, capacity).
 */
export function scoreRisk(profile: UserProfile, answers: RiskAnswers = profile.riskAnswers): RiskProfile {
  const drivers: string[] = [];

  const scoreFor = (dimension: 'tolerance' | 'capacity'): number | null => {
    const questions = RISK_QUESTIONS.filter((q) => q.dimension === dimension);
    const answered = questions.filter((q) => typeof answers[q.id] === 'number');
    if (answered.length === 0) return null;
    const total = answered.reduce((acc, q) => {
      const idx = clamp(answers[q.id] ?? 0, 0, q.scores.length - 1);
      return acc + (q.scores[idx] ?? 0);
    }, 0);
    return total / answered.length;
  };

  const answeredTolerance = scoreFor('tolerance');
  const answeredCapacity = scoreFor('capacity');

  // Un-profiled users start at "Balanced", not "Aggressive".
  const toleranceScore = answeredTolerance ?? 50;
  if (answeredTolerance === null) {
    drivers.push('Risk questionnaire not completed yet - defaulting to a balanced stance.');
  }

  const monthlyExpenses = Object.values(profile.cashflow.monthlyExpenses).reduce(
    (a, b) => a + b,
    0,
  );
  const bufferMonths = monthlyExpenses > 0 ? profile.liquidSavings / monthlyExpenses : 0;
  const yearsToRetirement = Math.max(0, profile.retirementAge - profile.age);
  const totalEmi = profile.liabilities.reduce((acc, l) => acc + l.emi, 0);
  const income = profile.cashflow.monthlyNetIncome + profile.cashflow.otherMonthlyIncome;
  const dti = income > 0 ? totalEmi / income : 0;

  // Structural capacity, built from facts rather than self-report.
  const horizonScore = clamp((yearsToRetirement / 30) * 100, 0, 100);
  const bufferScore = clamp((bufferMonths / 6) * 100, 0, 100);
  const dependentsScore = clamp(100 - profile.dependents * 18, 20, 100);
  const stabilityScore =
    profile.incomeStability === 'stable' ? 100 : profile.incomeStability === 'variable' ? 60 : 30;
  const debtScore = clamp(100 - dti * 200, 0, 100);

  const structuralCapacity =
    horizonScore * 0.3 +
    bufferScore * 0.25 +
    dependentsScore * 0.12 +
    stabilityScore * 0.18 +
    debtScore * 0.15;

  // Self-reported capacity gets a 35% say; the balance sheet gets the rest.
  const blendedCapacity =
    answeredCapacity === null
      ? structuralCapacity
      : structuralCapacity * 0.65 + answeredCapacity * 0.35;

  /*
   * Knock-out constraints.
   *
   * A weighted average lets one strong input paper over a disqualifying one - a
   * 34-year horizon would otherwise score away the fact that the user has six
   * weeks of savings and a 42% credit-card balance. Real risk questionnaires
   * use hard caps for exactly this reason, so capacity is the *minimum* of the
   * blended score and every cap that applies.
   */
  const caps: { cap: number; reason: string }[] = [];
  if (bufferMonths < 1) {
    caps.push({
      cap: 30,
      reason: `Less than a month of expenses in reserve caps risk capacity - any shock would force selling at the worst time.`,
    });
  } else if (bufferMonths < 3) {
    caps.push({
      cap: 55,
      reason: `Under three months of emergency cover caps risk capacity until the buffer is rebuilt.`,
    });
  }
  const highCostDebt = profile.liabilities
    .filter((l) => l.interestRatePct > 0.15)
    .reduce((acc, l) => acc + l.outstanding, 0);
  if (highCostDebt > income) {
    caps.push({
      cap: 50,
      reason: `High-interest debt of more than a month's income caps risk capacity - clearing it is a better risk-adjusted return than any portfolio.`,
    });
  }
  if (dti > 0.5) {
    caps.push({
      cap: 40,
      reason: `EMIs above half of income leave no room to absorb a drawdown.`,
    });
  }

  const capacityScore = caps.reduce((acc, c) => Math.min(acc, c.cap), blendedCapacity);
  for (const c of caps) {
    if (c.cap < blendedCapacity) drivers.push(c.reason);
  }

  if (yearsToRetirement > 25) {
    drivers.push(`${yearsToRetirement} years to retirement gives volatility time to average out.`);
  } else if (yearsToRetirement < 10) {
    drivers.push(
      `Only ${yearsToRetirement} years to retirement, so a deep drawdown would be hard to recover from.`,
    );
  }
  if (bufferMonths < 3) {
    drivers.push(
      `Emergency buffer covers ${bufferMonths.toFixed(1)} months - below the 3-month floor, which caps risk capacity.`,
    );
  } else if (bufferMonths >= 6) {
    drivers.push(`${bufferMonths.toFixed(1)} months of expenses in reserve supports taking equity risk.`);
  }
  if (dti > 0.4) {
    drivers.push(`EMIs take ${(dti * 100).toFixed(0)}% of income, which limits how much risk is affordable.`);
  }
  if (profile.incomeStability !== 'stable') {
    drivers.push(`Income is ${profile.incomeStability}, so the plan keeps a larger liquid cushion.`);
  }
  if (profile.dependents > 0) {
    drivers.push(`${profile.dependents} dependent(s) raise the cost of getting this wrong.`);
  }

  const effectiveScore = Math.min(toleranceScore, capacityScore);
  if (capacityScore < toleranceScore - 10) {
    drivers.push(
      'Appetite for risk currently runs ahead of the ability to absorb it - the recommendation follows the lower of the two.',
    );
  }

  return {
    toleranceScore: round(toleranceScore, 0),
    capacityScore: round(capacityScore, 0),
    effectiveScore: round(effectiveScore, 0),
    bucket: bucketFor(effectiveScore),
    drivers,
  };
}
