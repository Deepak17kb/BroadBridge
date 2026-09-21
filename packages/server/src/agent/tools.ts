import type Anthropic from '@anthropic-ai/sdk';
import {
  ASSET_CLASSES,
  buildSnapshot,
  computeActionImpact,
  describeLevers,
  optimiseGoalFunding,
  planDebtPayoff,
  planningHorizon,
  portfolioExpectedReturn,
  portfolioVolatility,
  projectGoal,
  recommendAllocation,
  resolveAssumptions,
  returnForGoal,
  runMonteCarlo,
  runScenario,
  SCENARIO_PRESETS,
  scoreRisk,
  formatCompact,
  type AgentAttachment,
  type AllocationWeights,
  type ScenarioLevers,
  type UserProfile,
} from '@wealth/shared';
import { config } from '../config.js';
import { leverSchema } from '../lib/levers.js';
import { retrieve } from './knowledge/retriever.js';

/**
 * The agent's tool surface.
 *
 * Every tool is a thin wrapper over the same engine the UI uses. The model
 * decides *which* questions to ask and *how* to explain the answers; it never
 * computes a number itself. That separation is the whole design: arithmetic is
 * deterministic and testable, language is the model's job, and a hallucinated
 * figure has nowhere to enter.
 *
 * Each handler returns a `summary` for the trace, `data` for the UI to render
 * as a card, and `facts` - a flat map of every number the tool produced, which
 * the verifier later uses to check the model's prose against reality.
 */

export interface ToolContext {
  profile: UserProfile;
  /** Mutated by tools that change the plan, then persisted by the caller. */
  onProfileChange?: (profile: UserProfile) => void;
}

export interface ToolResult {
  summary: string;
  data: unknown;
  /** Numeric claims this tool supports, keyed by a human-readable label. */
  facts: Record<string, number>;
  /** Optional rich payload for the chat UI. */
  attachment?: AgentAttachment;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** Shown in the trace while the tool runs. */
  label: string;
  inputSchema: Anthropic.Tool['input_schema'];
  handler: (input: any, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
}

const currencyOf = (ctx: ToolContext) => ctx.profile.currency;
const money = (value: number, ctx: ToolContext) => formatCompact(value, currencyOf(ctx));
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

/**
 * The model's lever values, checked against the same schema the HTTP route
 * uses. Non-numeric fields are dropped first, as before; out-of-range ones are
 * reported back so the model can correct itself rather than narrate garbage.
 */
function validateLevers(
  raw: Record<string, unknown>,
): { ok: true; levers: ScenarioLevers } | { ok: false; problems: string } {
  const numeric = Object.fromEntries(
    Object.entries(raw).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)),
  );
  const parsed = leverSchema.safeParse(numeric);
  if (parsed.success) return { ok: true, levers: parsed.data as ScenarioLevers };
  return {
    ok: false,
    problems: parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'levers'}: ${issue.message}`)
      .join('; '),
  };
}

const LEVER_UNITS =
  'Fractions are decimals: marketShockPct -0.35 is a 35% crash, inflationPct 0.08 is 8%, expenseMultiplier 0.9 is 10% less spending.';

const GOAL_KINDS = ['retirement', 'home', 'education', 'vehicle', 'travel', 'emergency', 'wealth', 'custom'] as const;

/** Collapses an allocation into a readable sentence. */
function describeAllocation(weights: AllocationWeights): string {
  return ASSET_CLASSES.filter((ac) => (weights[ac] ?? 0) >= 0.01)
    .map((ac) => `${ac.replace(/_/g, ' ')} ${((weights[ac] ?? 0) * 100).toFixed(0)}%`)
    .join(', ');
}

/**
 * Every number the snapshot contains, flattened for the grounding verifier.
 *
 * Shared by the tools that narrate the position, so a figure quoted by one is
 * verifiable regardless of which tool the model happened to call.
 */
function snapshotFacts(snapshot: import('@wealth/shared').FinancialSnapshot): Record<string, number> {
  return {
    'net worth': snapshot.netWorth.netWorth,
    'total assets': snapshot.netWorth.assets,
    'total liabilities': snapshot.netWorth.liabilities,
    'liquid assets': snapshot.netWorth.liquidAssets,
    'invested assets': snapshot.netWorth.investedAssets,
    'monthly income': snapshot.cashflow.monthlyIncome,
    'monthly expenses': snapshot.cashflow.monthlyExpenses,
    'monthly surplus': snapshot.cashflow.monthlySurplus,
    'savings rate': snapshot.cashflow.savingsRatePct,
    'total emi': snapshot.cashflow.totalEmi,
    'emergency fund months': snapshot.cashflow.emergencyFundMonths,
    'emergency fund gap': snapshot.cashflow.emergencyFundGap,
    'emergency fund target': snapshot.cashflow.emergencyFundTarget,
    'debt to income': snapshot.cashflow.debtToIncomeRatio,
    'portfolio value': snapshot.portfolio.totalValue,
    'expected return': snapshot.portfolio.expectedReturnPct,
    volatility: snapshot.portfolio.volatilityPct,
    'sharpe ratio': snapshot.portfolio.sharpeRatio,
    'blended expense ratio': snapshot.portfolio.blendedExpenseRatioPct,
    'diversification score': snapshot.portfolio.diversificationScore,
    'effective positions': snapshot.portfolio.effectivePositions,
    'portfolio drift': snapshot.portfolio.totalDriftPct,
    'unrealised gain': snapshot.portfolio.unrealisedGain,
    'wellness score': snapshot.wellness.total,
    'retirement readiness': snapshot.retirement.readinessRatio,
    'retirement corpus required': snapshot.retirement.corpusRequired,
    'retirement projected corpus': snapshot.retirement.projectedCorpus,
    'retirement annual spend': snapshot.retirement.targetAnnualSpend,
    'retirement monthly gap': snapshot.retirement.monthlyGap,
    'years to retirement': snapshot.retirement.yearsToRetirement,
    'risk tolerance score': snapshot.risk.toleranceScore,
    'risk capacity score': snapshot.risk.capacityScore,
    ...(snapshot.portfolio.largestSingleSecurity
      ? { 'largest single security weight': snapshot.portfolio.largestSingleSecurity.weight }
      : {}),
    // Per-goal figures, so any statement about a goal traces to a tool output
    // rather than reading as invented.
    ...Object.fromEntries(
      snapshot.goalProjections.flatMap((g) => [
        [`${g.goalName} inflated target`, g.inflatedTarget],
        [`${g.goalName} projected corpus`, g.projectedCorpus],
        [`${g.goalName} shortfall`, Math.abs(g.surplus)],
        [`${g.goalName} required monthly`, g.requiredMonthly],
        [`${g.goalName} monthly gap`, g.monthlyGap],
        [`${g.goalName} funded ratio`, g.fundedRatio],
        [`${g.goalName} years to goal`, g.yearsToGoal],
      ]),
    ),
    ...Object.fromEntries(snapshot.wellness.pillars.map((p) => [`${p.name} pillar score`, p.score])),
    // Each action's impact figure plus the evidence behind its own wording.
    ...Object.fromEntries(snapshot.actions.map((a) => [`${a.title} impact`, a.impact.value])),
    ...Object.assign({}, ...snapshot.actions.map((a) => a.evidence ?? {})),
  };
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'get_financial_snapshot',
    label: 'Reading the financial position',
    description:
      'Returns the complete current financial picture: net worth, cashflow, savings rate, emergency-fund status, portfolio analytics, risk profile, every goal projection, retirement readiness and the wellness score. Call this first for almost any question - it is one cheap call that grounds everything else.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: (_input, ctx) => {
      const snapshot = buildSnapshot(ctx.profile);
      return {
        summary: [
          `Net worth ${money(snapshot.netWorth.netWorth, ctx)}`,
          `surplus ${money(snapshot.cashflow.monthlySurplus, ctx)}/month`,
          `savings rate ${pct(snapshot.cashflow.savingsRatePct)}`,
          `emergency cover ${snapshot.cashflow.emergencyFundMonths} months`,
          `risk ${snapshot.risk.bucket}`,
          `retirement ${pct(snapshot.retirement.readinessRatio)} funded`,
          `${snapshot.goalProjections.filter((g) => g.onTrack).length}/${snapshot.goalProjections.length} goals on track`,
          `wellness ${snapshot.wellness.total}/100 (${snapshot.wellness.grade})`,
        ].join(' | '),
        data: snapshot,
        facts: snapshotFacts(snapshot),
      };
    },
  },

  {
    name: 'project_goal',
    label: 'Projecting a goal',
    description:
      'Projects one goal to its target date and reports the funding gap. Returns the inflation-adjusted target, projected corpus, shortfall, the monthly contribution that would exactly fund it, and the return that would be needed instead. Use the goal id or name from the snapshot. Optionally test an extra monthly contribution or a lump sum.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Goal id or name (case-insensitive substring match)' },
        extraMonthly: { type: 'number', description: 'Additional monthly contribution to test' },
        lumpSum: { type: 'number', description: 'One-off amount invested today' },
      },
      required: ['goal'],
    },
    handler: (input: { goal: string; extraMonthly?: number; lumpSum?: number }, ctx) => {
      const needle = String(input.goal).toLowerCase();
      const goal =
        ctx.profile.goals.find((g) => g.id.toLowerCase() === needle) ??
        ctx.profile.goals.find((g) => g.name.toLowerCase().includes(needle));
      if (!goal) {
        return {
          summary: `No goal matched "${input.goal}". Available: ${ctx.profile.goals.map((g) => g.name).join(', ') || 'none'}.`,
          data: { error: 'goal_not_found', available: ctx.profile.goals.map((g) => g.name) },
          facts: {},
        };
      }
      const assumptions = resolveAssumptions(ctx.profile);
      const projection = projectGoal(goal, {
        annualReturn: returnForGoal(goal, ctx.profile, assumptions),
        assumptions,
        extraMonthly: input.extraMonthly,
        lumpSum: input.lumpSum,
      });
      return {
        summary: `${projection.goalName}: needs ${money(projection.inflatedTarget, ctx)} in ${projection.yearsToGoal.toFixed(1)} years, projected ${money(projection.projectedCorpus, ctx)} (${pct(projection.fundedRatio)} funded). ${projection.onTrack ? 'On track.' : `Short by ${money(Math.abs(projection.surplus), ctx)}; needs ${money(projection.requiredMonthly, ctx)}/month instead of ${money(goal.monthlyContribution, ctx)}.`}`,
        data: projection,
        attachment: { kind: 'goal_projection', data: projection },
        facts: {
          [`${projection.goalName} inflated target`]: projection.inflatedTarget,
          [`${projection.goalName} projected corpus`]: projection.projectedCorpus,
          [`${projection.goalName} shortfall`]: Math.abs(projection.surplus),
          [`${projection.goalName} funded ratio`]: projection.fundedRatio,
          [`${projection.goalName} required monthly`]: projection.requiredMonthly,
          [`${projection.goalName} monthly gap`]: projection.monthlyGap,
          [`${projection.goalName} years`]: projection.yearsToGoal,
          // Published because the narration quotes them: the contribution
          // actually in place, and the return the projection assumed.
          [`${projection.goalName} current contribution`]: goal.monthlyContribution,
          [`${projection.goalName} assumed return`]: projection.assumedReturnPct,
          ...(projection.requiredReturnPct !== null
            ? { [`${projection.goalName} required return`]: projection.requiredReturnPct }
            : {}),
        },
      };
    },
  },

  {
    name: 'simulate_scenario',
    label: 'Running a what-if scenario',
    description:
      'Runs a full what-if simulation and returns the outcome plus the delta against the current plan. Levers: extraMonthlySavings, expenseMultiplier (0.9 = spend 10% less), retirementAgeDelta (-5 = retire five years earlier), lumpSum, marketShockPct with shockYear (-0.35 in year 3 = a 35% crash), careerBreakMonths, incomeGrowthPct, inflationPct. Includes a Monte Carlo run with a success probability. Use this for every "what if" question.',
    inputSchema: {
      type: 'object',
      properties: {
        extraMonthlySavings: { type: 'number' },
        expenseMultiplier: { type: 'number', description: '0.9 means spending 10% less' },
        retirementAgeDelta: { type: 'number', description: 'Years earlier (negative) or later' },
        lumpSum: { type: 'number' },
        marketShockPct: { type: 'number', description: '-0.35 for a 35% drawdown' },
        shockYear: { type: 'number', description: 'Years from now the shock lands' },
        careerBreakMonths: { type: 'number' },
        incomeGrowthPct: { type: 'number', description: 'Decimal, e.g. 0.08' },
        inflationPct: { type: 'number', description: 'Decimal, e.g. 0.08' },
        label: { type: 'string', description: 'Short human-readable name for this scenario' },
      },
      required: [],
    },
    handler: (input: ScenarioLevers & { label?: string }, ctx) => {
      const { label, ...levers } = input;
      const checked = validateLevers(levers);
      if (!checked.ok) {
        return {
          summary: `Nothing was simulated - these levers are out of range: ${checked.problems}. ${LEVER_UNITS}`,
          data: { error: 'invalid_levers', problems: checked.problems },
          facts: {},
        };
      }
      const cleaned = checked.levers;
      const result = runScenario({
        profile: ctx.profile,
        levers: cleaned,
        label: label ?? describeLevers(cleaned),
        paths: config.simulationPaths,
      });
      return {
        summary: `${result.label}: retirement corpus ${money(result.snapshot.netWorthAtRetirement, ctx)} (${result.deltaVsBaseline.netWorthAtRetirement >= 0 ? '+' : ''}${money(result.deltaVsBaseline.netWorthAtRetirement, ctx)} vs today's plan), ${pct(result.snapshot.retirementReadiness)} funded, ${pct(result.monteCarlo.successProbability)} of simulated paths reach the target, ${result.snapshot.goalsOnTrack}/${result.snapshot.goalsTotal} goals on track.`,
        data: result,
        attachment: { kind: 'scenario', data: result },
        facts: {
          'scenario retirement corpus': result.snapshot.netWorthAtRetirement,
          'scenario corpus change': result.deltaVsBaseline.netWorthAtRetirement,
          'scenario readiness': result.snapshot.retirementReadiness,
          'scenario success probability': result.monteCarlo.successProbability,
          'scenario wellness score': result.snapshot.wellnessScore,
          'scenario monthly surplus': result.snapshot.monthlySurplus,
          'scenario goals on track': result.snapshot.goalsOnTrack,
          'scenario median outcome': result.monteCarlo.median,
          'scenario p10 outcome': result.monteCarlo.p10,
          'scenario p90 outcome': result.monteCarlo.p90,
          'scenario expected return': result.snapshot.expectedReturnPct,
          'scenario volatility': result.snapshot.volatilityPct,
          // The lever values themselves: the scenario's label and explanation
          // restate them ("+20.0k/mo saved"), so they are claims too.
          ...Object.fromEntries(
            Object.entries(cleaned)
              .filter(([, v]) => typeof v === 'number')
              .map(([k, v]) => [`lever ${k}`, v as number]),
          ),
        },
      };
    },
  },

  {
    name: 'run_monte_carlo',
    label: 'Simulating market outcomes',
    description:
      'Runs a standalone Monte Carlo simulation on the retirement portfolio and returns percentile bands per year, the success probability against the required corpus, and the distribution of outcomes. Use when the question is specifically about probability, risk of failure, or the range of possible outcomes.',
    inputSchema: {
      type: 'object',
      properties: {
        years: { type: 'number', description: 'Horizon; defaults to years until retirement' },
        monthlyContribution: { type: 'number', description: 'Overrides the assumed contribution' },
        allocationRiskBucket: {
          type: 'string',
          enum: ['Conservative', 'Moderate', 'Balanced', 'Growth', 'Aggressive'],
          description: 'Test a different risk level than the recommended one',
        },
      },
      required: [],
    },
    handler: (
      input: { years?: number; monthlyContribution?: number; allocationRiskBucket?: any },
      ctx,
    ) => {
      const snapshot = buildSnapshot(ctx.profile);
      const assumptions = resolveAssumptions(ctx.profile);
      const years = input.years ?? Math.max(1, snapshot.retirement.yearsToRetirement);
      const allocation = input.allocationRiskBucket
        ? recommendAllocation(input.allocationRiskBucket, years)
        : snapshot.recommendedAllocation;
      // Defaults come from the retirement projection's own inputs so the
      // probability is about the plan the rest of the platform shows.
      const contribution = input.monthlyContribution ?? snapshot.retirement.plan.monthlyContribution;

      const result = runMonteCarlo({
        startingCorpus: snapshot.retirement.plan.startingCorpus,
        monthlyContribution: contribution,
        contributionStepUpPct: snapshot.retirement.plan.stepUpPct,
        years,
        expectedReturnPct: portfolioExpectedReturn(allocation, assumptions),
        volatilityPct: portfolioVolatility(allocation, assumptions),
        target: snapshot.retirement.corpusRequired,
        paths: config.simulationPaths,
        inflationPct: assumptions.inflationPct,
      });
      return {
        summary: `Over ${years} years: median ${money(result.median, ctx)}, 10th percentile ${money(result.p10, ctx)}, 90th percentile ${money(result.p90, ctx)}, and ${pct(result.successProbability)} of ${result.paths.toLocaleString('en-US')} simulated paths reach the ${money(result.target, ctx)} target. Figures in today's money.`,
        data: result,
        attachment: { kind: 'monte_carlo', data: result },
        facts: {
          'simulation median': result.median,
          'simulation p10': result.p10,
          'simulation p90': result.p90,
          'success probability': result.successProbability,
          'simulation target': result.target,
          'simulation paths': result.paths,
        },
      };
    },
  },

  {
    name: 'analyze_portfolio',
    label: 'Analysing the portfolio',
    description:
      'Analyses the holdings: asset-class weights, expected return and volatility from the full covariance matrix, Sharpe ratio, blended expense ratio, concentration, diversification score, drift from the recommended mix and the exact rebalancing trades. Use for any question about the portfolio, allocation, risk level, fees or rebalancing.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: (_input, ctx) => {
      const snapshot = buildSnapshot(ctx.profile);
      const p = snapshot.portfolio;
      return {
        summary: `${money(p.totalValue, ctx)} across ${ctx.profile.holdings.length} holdings. Expected return ${pct(p.expectedReturnPct)}, volatility ${pct(p.volatilityPct)}, Sharpe ${p.sharpeRatio}. Fees ${(p.blendedExpenseRatioPct * 100).toFixed(2)}%. Diversification ${p.diversificationScore}/100${p.largestSingleSecurity ? `, largest single security ${p.largestSingleSecurity.name} at ${pct(p.largestSingleSecurity.weight)}` : ''}. ${p.totalDriftPct}% of the portfolio is out of position versus target. Current: ${describeAllocation(p.weights)}. Recommended: ${describeAllocation(snapshot.recommendedAllocation)}.`,
        data: { portfolio: p, recommended: snapshot.recommendedAllocation, risk: snapshot.risk },
        attachment: {
          kind: 'allocation',
          data: { current: p.weights, recommended: snapshot.recommendedAllocation },
        },
        facts: {
          'portfolio value': p.totalValue,
          'expected return': p.expectedReturnPct,
          volatility: p.volatilityPct,
          'sharpe ratio': p.sharpeRatio,
          'blended expense ratio': p.blendedExpenseRatioPct,
          'diversification score': p.diversificationScore,
          'total drift': p.totalDriftPct,
          'effective positions': p.effectivePositions,
          'unrealised gain': p.unrealisedGain,
          ...(p.largestSingleSecurity
            ? { 'largest single security weight': p.largestSingleSecurity.weight }
            : {}),
        },
      };
    },
  },

  {
    name: 'recommend_allocation',
    label: 'Deriving the target allocation',
    description:
      'Returns the recommended asset allocation for a given risk bucket and horizon, with its expected return and volatility. Omit arguments to get the recommendation for this user. Use to compare risk levels or explain why a mix is being suggested.',
    inputSchema: {
      type: 'object',
      properties: {
        riskBucket: {
          type: 'string',
          enum: ['Conservative', 'Moderate', 'Balanced', 'Growth', 'Aggressive'],
        },
        years: { type: 'number', description: 'Horizon in years' },
      },
      required: [],
    },
    handler: (input: { riskBucket?: any; years?: number }, ctx) => {
      const risk = scoreRisk(ctx.profile);
      const assumptions = resolveAssumptions(ctx.profile);
      const years = input.years ?? planningHorizon(ctx.profile);
      const bucket = input.riskBucket ?? risk.bucket;
      const weights = recommendAllocation(bucket, years);
      const expected = portfolioExpectedReturn(weights, assumptions);
      const vol = portfolioVolatility(weights, assumptions);
      return {
        summary: `${bucket} over ${years.toFixed(0)} years: ${describeAllocation(weights)}. Expected ${pct(expected)} with ${pct(vol)} volatility. Assessed risk: tolerance ${risk.toleranceScore}/100, capacity ${risk.capacityScore}/100, so the plan uses ${risk.bucket}. Reasons: ${risk.drivers.join(' ')}`,
        data: { weights, expected, volatility: vol, risk, bucket, years },
        facts: {
          'allocation expected return': expected,
          'allocation volatility': vol,
          'risk tolerance score': risk.toleranceScore,
          'risk capacity score': risk.capacityScore,
        },
      };
    },
  },

  {
    name: 'get_next_best_actions',
    label: 'Ranking the next best actions',
    description:
      'Returns the prioritised action list for this user, each with a quantified impact, the reasoning, concrete steps and its assumptions. Use when asked what to do next, where to start, or how to improve the plan. Do not invent actions - narrate these.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many actions to return (default 5)' },
        category: {
          type: 'string',
          enum: ['protection', 'debt', 'savings', 'investing', 'tax', 'goals', 'efficiency'],
        },
      },
      required: [],
    },
    handler: (input: { limit?: number; category?: string }, ctx) => {
      const snapshot = buildSnapshot(ctx.profile);
      let actions = snapshot.actions;
      if (input.category) actions = actions.filter((a) => a.category === input.category);
      actions = actions.slice(0, input.limit ?? 5);
      return {
        summary: actions.length
          ? actions
              .map(
                (a, i) =>
                  `${i + 1}. ${a.title} (${a.category}, priority ${a.priorityScore}) - ${a.impact.metric}: ${a.impact.unit === 'currency' ? money(a.impact.value, ctx) : a.impact.unit === 'percent' ? `${a.impact.value}%` : `${a.impact.value} ${a.impact.unit}`}`,
              )
              .join('\n')
          : 'No actions in that category.',
        data: actions,
        attachment: { kind: 'actions', data: actions },
        // The action prose quotes goal and cashflow figures, so the whole
        // snapshot fact set travels with it.
        facts: snapshotFacts(snapshot),
      };
    },
  },

  {
    name: 'estimate_action_impact',
    label: 'Costing out the plan',
    description:
      "Reports what following the top-ranked actions would actually change: wellness score, retirement funded percentage, median corpus and emergency cover, before and after, with each action's marginal contribution. Use when asked whether the advice is worth following, what difference it makes, or which action matters most. Only counts actions the platform can apply and the user can afford - everything else is returned as not modelled, and must not be described as part of the gain.",
    inputSchema: {
      type: 'object',
      properties: {
        top: { type: 'number', description: 'How many applicable actions to include (default 3)' },
      },
      required: [],
    },
    handler: (input: { top?: number }, ctx) => {
      const topN = Math.min(Math.max(Math.trunc(input.top ?? 3), 1), 10);
      const impact = computeActionImpact({ profile: ctx.profile, topN });

      if (impact.noop) {
        return {
          summary:
            'Nothing in the ranked list can be applied by the platform for this profile, so there is no modelled impact to report. Every remaining action needs the user to act themselves.',
          data: impact,
          facts: {},
        };
      }

      const lines = [
        `Following the top ${impact.applied.length} applicable actions:`,
        `- Wellness score ${impact.before.wellnessScore} (${impact.before.wellnessGrade}) to ${impact.after.wellnessScore} (${impact.after.wellnessGrade})`,
        `- Retirement funded ${(impact.before.retirementFundedPct * 100).toFixed(0)}% to ${(impact.after.retirementFundedPct * 100).toFixed(0)}%`,
        `- Median corpus ${money(impact.before.medianCorpusAtRetirement, ctx)} to ${money(impact.after.medianCorpusAtRetirement, ctx)}`,
        `- Emergency cover ${impact.before.emergencyFundMonths.toFixed(1)} to ${impact.after.emergencyFundMonths.toFixed(1)} months`,
        '',
        'Marginal contribution of each, applied in rank order:',
        ...impact.applied.map(
          (a) =>
            `- ${a.title}: wellness ${a.marginal.wellnessScore >= 0 ? '+' : ''}${a.marginal.wellnessScore}, median corpus ${a.marginal.medianCorpusAtRetirement >= 0 ? '+' : ''}${money(a.marginal.medianCorpusAtRetirement, ctx)}`,
        ),
        '',
        `${impact.notModelled.length} further actions are NOT included in these figures - they need the user to buy a policy, refinance or open an account, or would cost more per month than the surplus covers.`,
      ];

      return {
        summary: lines.join('\n'),
        data: impact,
        facts: {
          'wellness score before': impact.before.wellnessScore,
          'wellness score after': impact.after.wellnessScore,
          'retirement funded before': impact.before.retirementFundedPct,
          'retirement funded after': impact.after.retirementFundedPct,
          'median corpus before': impact.before.medianCorpusAtRetirement,
          'median corpus after': impact.after.medianCorpusAtRetirement,
          'emergency cover before': impact.before.emergencyFundMonths,
          'emergency cover after': impact.after.emergencyFundMonths,
          'actions counted': impact.applied.length,
          'actions not counted': impact.notModelled.length,
          ...Object.fromEntries(
            impact.applied.map((a) => [`${a.id} marginal corpus`, a.marginal.medianCorpusAtRetirement]),
          ),
        },
      };
    },
  },

  {
    name: 'optimise_goal_funding',
    label: 'Splitting the surplus across the goals',
    description:
      "Divides the money available each month across the user's goals and reports what the goals that lose out actually lose, in years of delay. Use whenever a goal is short, whenever the user asks which goal to fund first, or whenever the separate per-goal gaps add up to more than they earn. The pool is free surplus plus what the goals already receive, so it works even when there is no spare cash - the answer is then that the committed money is pointed at the wrong goals. Never present the per-goal gaps as if they could all be funded at once without checking this first.",
    inputSchema: {
      type: 'object',
      properties: {
        surplusOverride: {
          type: 'number',
          description: 'Divide this monthly amount instead of the computed pool',
        },
      },
      required: [],
    },
    handler: (input: { surplusOverride?: number }, ctx) => {
      const result = optimiseGoalFunding({
        profile: ctx.profile,
        surplusOverride: input.surplusOverride,
      });

      const lines = [
        `Dividing ${money(result.available, ctx)} a month across ${result.allocations.length} goals:`,
        ...result.allocations.map(
          (a) =>
            `- ${a.goalName} (${a.priority.replace('_', ' ')}, ${a.yearsToGoal.toFixed(1)}y): gets ${money(a.allocated, ctx)} of the ${money(a.requiredMonthly, ctx)} it needs, leaving it ${(a.resultingFundedRatio * 100).toFixed(0)}% funded${a.onTrack ? ' - on track' : ''}`,
        ),
        ...(result.starved.length
          ? [
              '',
              'What that costs:',
              ...result.starved.map(
                (s) =>
                  `- ${s.goalName} is short ${money(s.unmetMonthly, ctx)} a month and arrives ${
                    s.yearsDelayIfUnfunded === null
                      ? 'not at all within 40 years'
                      : `about ${s.yearsDelayIfUnfunded} years later`
                  }`,
              ),
            ]
          : []),
        ...(result.toRetirementGap > 0
          ? ['', `${money(result.toRetirementGap, ctx)} a month is left over and goes to the retirement gap.`]
          : []),
        '',
        result.rationale,
      ];

      return {
        summary: lines.join('\n'),
        data: result,
        facts: {
          'monthly pool available': result.available,
          'unallocated monthly': result.unallocated,
          'to retirement gap': result.toRetirementGap,
          'to invest': result.toInvest,
          ...Object.fromEntries(
            result.allocations.flatMap((a) => [
              [`${a.goalName} allocated`, a.allocated],
              [`${a.goalName} required monthly`, a.requiredMonthly],
              [`${a.goalName} funded ratio after allocation`, a.resultingFundedRatio],
            ]),
          ),
          ...Object.fromEntries(
            result.starved.flatMap((s) => [
              [`${s.goalName} unmet monthly`, s.unmetMonthly],
              ...(s.yearsDelayIfUnfunded !== null
                ? [[`${s.goalName} years of delay`, s.yearsDelayIfUnfunded] as const]
                : []),
            ]),
          ),
        },
      };
    },
  },

  {
    name: 'plan_debt_payoff',
    label: 'Comparing debt payoff strategies',
    description:
      'Compares avalanche (highest interest rate first) and snowball (smallest balance first) payoff plans, returning months to debt-free and total interest for each. Use for any question about clearing loans or credit cards.',
    inputSchema: {
      type: 'object',
      properties: {
        extraMonthly: { type: 'number', description: 'Extra amount available each month' },
      },
      required: [],
    },
    handler: (input: { extraMonthly?: number }, ctx): ToolResult => {
      if (ctx.profile.liabilities.length === 0) {
        return { summary: 'This user has no liabilities recorded.', data: { debts: [] }, facts: {} };
      }
      const extra = input.extraMonthly ?? 0;
      const avalanche = planDebtPayoff(ctx.profile, 'avalanche', extra);
      const snowball = planDebtPayoff(ctx.profile, 'snowball', extra);
      const saving = snowball.totalInterestPaid - avalanche.totalInterestPaid;
      // Avalanche is usually cheaper, not always: a debt that never clears is
      // left out of one order's total. The sentence follows the numbers.
      const verdict =
        saving > 0
          ? `Avalanche saves ${money(saving, ctx)}`
          : saving < 0
            ? `Snowball costs ${money(-saving, ctx)} less here`
            : 'Both orders cost the same';
      // An unpayable debt is the headline, not a footnote: no payoff date the
      // plan reports is meaningful while a balance is still growing.
      const blocked = avalanche.unpayable.length
        ? ` WARNING: ${avalanche.unpayable
            .map(
              (u) =>
                `${u.name} at ${(u.interestRatePct * 100).toFixed(1)}% never clears - the payment is ${money(u.monthlyShortfall, ctx)}/month short of even covering its interest, so the balance grows`,
            )
            .join('; ')}.`
        : '';
      return {
        summary: `Avalanche: clears ${avalanche.order.length} of ${ctx.profile.liabilities.length} debts in ${avalanche.monthsToDebtFree} months, ${money(avalanche.totalInterestPaid, ctx)} total interest. Snowball: ${snowball.monthsToDebtFree} months, ${money(snowball.totalInterestPaid, ctx)}. ${verdict}${extra ? ` with ${money(extra, ctx)}/month extra` : ''}. Order: ${avalanche.order.map((o) => o.name).join(' → ') || 'none clears'}.${blocked}`,
        data: { avalanche, snowball, interestSaved: saving },
        attachment: { kind: 'debt_plan', data: avalanche },
        facts: {
          'avalanche months': avalanche.monthsToDebtFree,
          'avalanche interest': avalanche.totalInterestPaid,
          'snowball months': snowball.monthsToDebtFree,
          'snowball interest': snowball.totalInterestPaid,
          [saving >= 0 ? 'interest saved by avalanche' : 'interest saved by snowball']: Math.abs(saving),
          ...Object.fromEntries(
            avalanche.unpayable.map((u) => [`${u.name} monthly shortfall`, u.monthlyShortfall]),
          ),
        },
      };
    },
  },

  {
    name: 'compare_scenarios',
    label: 'Comparing scenarios side by side',
    description:
      'Runs two or more scenarios and ranks them by projected retirement corpus, so alternatives can be compared directly. Pass an array of lever sets. Use when the user asks which of several options is better.',
    inputSchema: {
      type: 'object',
      properties: {
        scenarios: {
          type: 'array',
          description: 'Each entry is a set of levers plus a label',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              extraMonthlySavings: { type: 'number' },
              expenseMultiplier: { type: 'number' },
              retirementAgeDelta: { type: 'number' },
              lumpSum: { type: 'number' },
              marketShockPct: { type: 'number' },
              shockYear: { type: 'number' },
              careerBreakMonths: { type: 'number' },
              incomeGrowthPct: { type: 'number' },
              inflationPct: { type: 'number' },
            },
          },
        },
      },
      required: ['scenarios'],
    },
    handler: (input: { scenarios: (ScenarioLevers & { label?: string })[] }, ctx) => {
      const baseline = buildSnapshot(ctx.profile);
      const rejected: string[] = [];
      const results = (Array.isArray(input.scenarios) ? input.scenarios : [])
        .slice(0, 4)
        .flatMap((raw) => {
          const { label, ...levers } = raw ?? {};
          const checked = validateLevers(levers);
          if (!checked.ok) {
            rejected.push(`"${label ?? 'unnamed'}" (${checked.problems})`);
            return [];
          }
          const cleaned = checked.levers;
          return [
            runScenario({
              profile: ctx.profile,
              levers: cleaned,
              label: label ?? describeLevers(cleaned),
              baseline,
              // Fewer paths per scenario keeps a four-way comparison responsive.
              paths: Math.max(500, Math.floor(config.simulationPaths / 2)),
            }),
          ];
        });
      const ranked = [...results].sort(
        (a, b) => b.snapshot.netWorthAtRetirement - a.snapshot.netWorthAtRetirement,
      );
      const skippedNote = rejected.length
        ? `\nNot run, levers out of range: ${rejected.join('; ')}. ${LEVER_UNITS}`
        : '';
      return {
        summary:
          (ranked.length
            ? ranked
                .map(
                  (r, i) =>
                    `${i + 1}. ${r.label}: ${money(r.snapshot.netWorthAtRetirement, ctx)} (${r.deltaVsBaseline.netWorthAtRetirement >= 0 ? '+' : ''}${money(r.deltaVsBaseline.netWorthAtRetirement, ctx)}), ${pct(r.snapshot.retirementReadiness)} funded, ${pct(r.monteCarlo.successProbability)} success`,
                )
                .join('\n')
            : 'No scenarios could be run.') + skippedNote,
        data: { baseline: baseline.retirement.projectedCorpus, results: ranked },
        facts: {
          'baseline retirement corpus': baseline.retirement.projectedCorpus,
          ...Object.fromEntries(
            ranked.flatMap((r) => [
              [`${r.label} corpus`, r.snapshot.netWorthAtRetirement],
              [`${r.label} corpus change`, r.deltaVsBaseline.netWorthAtRetirement],
              [`${r.label} success probability`, r.monteCarlo.successProbability],
              [`${r.label} readiness`, r.snapshot.retirementReadiness],
              [`${r.label} expected return`, r.snapshot.expectedReturnPct],
            ]),
          ),
        },
      };
    },
  },

  {
    name: 'search_knowledge',
    label: 'Consulting the knowledge base',
    description:
      'Searches the financial-planning knowledge base for the principle behind a recommendation - emergency funds, debt versus investing, asset allocation, inflation, sequencing risk, safe withdrawal rates, fees, rebalancing, insurance and investor behaviour. Use when the user asks *why* something is advised, or when an explanation needs grounding.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up' },
        limit: { type: 'number', description: 'Documents to return (default 3)' },
      },
      required: ['query'],
    },
    handler: (input: { query: string; limit?: number }) => {
      const hits = retrieve(String(input.query ?? ''), input.limit ?? 3);
      return {
        summary: hits.length
          ? hits.map((h) => `[${h.id}] ${h.title} (score ${h.score}): ${h.snippet}`).join('\n\n')
          : 'Nothing in the knowledge base matched that query.',
        data: hits,
        facts: {},
      };
    },
  },

  {
    name: 'update_plan',
    label: 'Updating the plan',
    description:
      'Applies a change the user has explicitly asked for: adjust a goal contribution, add a goal, or change the retirement age. Only call this when the user has clearly asked for the change to be made - never speculatively, and never to test an idea (use simulate_scenario for that).',
    inputSchema: {
      type: 'object',
      properties: {
        change: {
          type: 'string',
          enum: ['set_goal_contribution', 'add_goal', 'set_retirement_age'],
        },
        goal: { type: 'string', description: 'Goal id or name, for set_goal_contribution' },
        monthlyContribution: { type: 'number' },
        retirementAge: { type: 'number' },
        newGoal: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            targetAmountToday: { type: 'number' },
            targetYear: { type: 'number' },
            monthlyContribution: { type: 'number' },
            kind: {
              type: 'string',
              enum: ['retirement', 'home', 'education', 'vehicle', 'travel', 'emergency', 'wealth', 'custom'],
            },
          },
        },
      },
      required: ['change'],
    },
    handler: (input: any, ctx): ToolResult => {
      const before = buildSnapshot(ctx.profile);
      const profile: UserProfile = structuredClone(ctx.profile);

      if (input.change === 'set_goal_contribution') {
        const needle = String(input.goal ?? '').toLowerCase();
        const goal =
          profile.goals.find((g) => g.id.toLowerCase() === needle) ??
          profile.goals.find((g) => g.name.toLowerCase().includes(needle));
        if (!goal) {
          return { summary: `No goal matched "${input.goal}". Nothing changed.`, data: { error: 'goal_not_found' }, facts: {} };
        }
        if (
          typeof input.monthlyContribution !== 'number' ||
          !Number.isFinite(input.monthlyContribution) ||
          input.monthlyContribution < 0
        ) {
          return { summary: 'A non-negative monthlyContribution is required. Nothing changed.', data: { error: 'invalid_amount' }, facts: {} };
        }
        const previous = goal.monthlyContribution;
        goal.monthlyContribution = input.monthlyContribution;
        const after = buildSnapshot(profile);
        ctx.onProfileChange?.(profile);
        return {
          summary: `"${goal.name}" contribution changed from ${money(previous, ctx)} to ${money(goal.monthlyContribution, ctx)}/month. Wellness score ${before.wellness.total} → ${after.wellness.total}; goals on track ${before.goalProjections.filter((g) => g.onTrack).length} → ${after.goalProjections.filter((g) => g.onTrack).length}.`,
          data: { goalId: goal.id, previous, current: goal.monthlyContribution, snapshot: after },
          facts: {
            'new contribution': goal.monthlyContribution,
            'wellness score': after.wellness.total,
          },
        };
      }

      /*
       * Every change here is held to the rules the profile schema enforces on
       * save. The route persists what this tool produces without re-validating
       * it, and a stored profile the schema would reject - a retirement age of
       * 62.5, a goal due last year, a kind the enum does not know - made every
       * later save from the browser fail until the user found and fixed it.
       */
      if (input.change === 'set_retirement_age') {
        const age = Number(input.retirementAge);
        if (!Number.isInteger(age) || age <= profile.age || age < 30 || age > 100) {
          return { summary: `Retirement age must be a whole number between ${Math.max(30, profile.age + 1)} and 100. Nothing changed.`, data: { error: 'invalid_age' }, facts: {} };
        }
        const previous = profile.retirementAge;
        profile.retirementAge = age;
        const after = buildSnapshot(profile);
        ctx.onProfileChange?.(profile);
        return {
          summary: `Retirement age changed from ${previous} to ${age}. Readiness ${pct(before.retirement.readinessRatio)} → ${pct(after.retirement.readinessRatio)}.`,
          data: { previous, current: age, snapshot: after },
          facts: { 'retirement age': age, 'retirement readiness': after.retirement.readinessRatio },
        };
      }

      if (input.change === 'add_goal') {
        const g = input.newGoal ?? {};
        if (!g.name || !Number.isFinite(g.targetAmountToday) || !Number.isFinite(g.targetYear)) {
          return { summary: 'A new goal needs at least a name, targetAmountToday and targetYear. Nothing changed.', data: { error: 'incomplete_goal' }, facts: {} };
        }
        const thisYear = new Date().getUTCFullYear();
        const targetYear = Number(g.targetYear);
        const targetAmount = Number(g.targetAmountToday);
        const contribution = Number(g.monthlyContribution ?? 0);
        const name = String(g.name).trim().slice(0, 120);
        if (!Number.isInteger(targetYear) || targetYear < thisYear || targetYear > 2150) {
          return { summary: `targetYear must be a whole year from ${thisYear} to 2150. Nothing changed.`, data: { error: 'invalid_goal' }, facts: {} };
        }
        if (targetAmount < 0 || !Number.isFinite(contribution) || contribution < 0 || !name) {
          return { summary: 'The goal needs a name, and its amounts cannot be negative. Nothing changed.', data: { error: 'invalid_goal' }, facts: {} };
        }
        if (profile.goals.length >= 30) {
          return { summary: 'A plan can hold at most 30 goals. Nothing changed.', data: { error: 'too_many_goals' }, facts: {} };
        }
        const id = `goal-${Date.now()}`;
        profile.goals.push({
          id,
          name,
          kind: (GOAL_KINDS as readonly string[]).includes(g.kind) ? g.kind : 'custom',
          targetAmountToday: targetAmount,
          targetYear,
          currentSaved: 0,
          monthlyContribution: contribution,
          contributionStepUpPct: 0,
          priority: 'important',
        });
        const after = buildSnapshot(profile);
        ctx.onProfileChange?.(profile);
        // By id: two goals can share a name, and the new one is the one to report.
        const projection = after.goalProjections.find((p) => p.goalId === id);
        return {
          summary: `Added "${g.name}": ${money(Number(g.targetAmountToday), ctx)} by ${g.targetYear}. ${projection ? `Needs ${money(projection.requiredMonthly, ctx)}/month to fund fully; currently set to ${money(Number(g.monthlyContribution ?? 0), ctx)}.` : ''}`,
          data: { snapshot: after, projection },
          facts: projection ? { 'new goal required monthly': projection.requiredMonthly } : {},
        };
      }

      return { summary: `Unsupported change "${input.change}". Nothing changed.`, data: { error: 'unsupported' }, facts: {} };
    },
  },

  {
    name: 'list_scenario_presets',
    label: 'Listing available scenarios',
    description:
      'Lists the built-in what-if scenarios the platform offers, with their levers. Useful when the user asks what they can explore.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: () => ({
      summary: SCENARIO_PRESETS.map((p) => `${p.label} - ${p.description}`).join('\n'),
      data: SCENARIO_PRESETS,
      facts: {},
    }),
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * Tool definitions in the shape the Messages API expects.
 *
 * `only` narrows the set to the named tools, in the declared order. The whole
 * catalogue is re-sent on every step of the agent loop - measured at 1,641
 * prompt tokens for all fourteen against Groq's tokeniser - so on an account
 * whose ceiling is a per-minute token allowance the schemas, not the
 * conversation, are what exhausts it. Names that match no tool are ignored, so
 * a caller may pass a plan containing `synthesize` without filtering it first.
 */
export function toolSchemas(only?: readonly string[]): Anthropic.Tool[] {
  const wanted = only ? new Set(only) : null;
  return TOOLS.filter((tool) => !wanted || wanted.has(tool.name)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = TOOL_MAP.get(name);
  if (!tool) {
    return {
      summary: `Unknown tool "${name}". Available: ${[...TOOL_MAP.keys()].join(', ')}.`,
      data: { error: 'unknown_tool' },
      facts: {},
    };
  }
  return tool.handler(input ?? {}, ctx);
}
