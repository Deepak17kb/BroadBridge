import { Router } from 'express';
import { z } from 'zod';
import {
  buildSnapshot,
  computeActionImpact,
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
  type ScenarioLevers,
} from '@wealth/shared';
import { config } from '../config.js';
import { asyncHandler, notFound, parseBody } from '../lib/http.js';
import { getStore } from '../store/index.js';

/**
 * Planning endpoints: scenarios, simulations, projections and debt plans.
 *
 * The browser runs the same engine locally for instant slider feedback, so
 * these exist for the cases where the server is the right place to compute -
 * shareable scenario results, the agent's tool calls, and any client that is
 * not this React app.
 */

export const router = Router();

const leverSchema = z.object({
  extraMonthlySavings: z.number().min(0).max(10_000_000).optional(),
  expenseMultiplier: z.number().min(0.1).max(3).optional(),
  retirementAgeDelta: z.number().int().min(-30).max(30).optional(),
  allocation: z.record(z.string(), z.number().min(0).max(1)).optional(),
  incomeGrowthPct: z.number().min(0).max(1).optional(),
  lumpSum: z.number().min(0).max(1_000_000_000).optional(),
  marketShockPct: z.number().min(-0.9).max(0.9).optional(),
  shockYear: z.number().min(0).max(60).optional(),
  careerBreakMonths: z.number().int().min(0).max(120).optional(),
  inflationPct: z.number().min(0).max(0.5).optional(),
});

router.get(
  '/presets',
  asyncHandler(async (_req, res) => {
    res.json(SCENARIO_PRESETS);
  }),
);

/** Runs one scenario against a stored profile. */
router.post(
  '/:id/scenario',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    const profile = await store.getProfile(req.params.id as string);
    if (!profile) throw notFound('Profile');

    const body = parseBody(
      z.object({
        levers: leverSchema,
        label: z.string().max(120).optional(),
        paths: z.number().int().min(200).max(20000).optional(),
        seed: z.number().int().optional(),
      }),
      req.body,
    );

    const result = runScenario({
      profile,
      levers: body.levers as ScenarioLevers,
      label: body.label,
      paths: body.paths ?? config.simulationPaths,
      seed: body.seed,
    });
    res.json(result);
  }),
);

/**
 * Runs several scenarios against one baseline.
 *
 * Sharing the baseline matters: computing it once per scenario would be wasted
 * work and, worse, would let the comparison drift if anything about the profile
 * were time-dependent.
 */
router.post(
  '/:id/scenarios/compare',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    const profile = await store.getProfile(req.params.id as string);
    if (!profile) throw notFound('Profile');

    const body = parseBody(
      z.object({
        scenarios: z
          .array(z.object({ label: z.string().max(120).optional(), levers: leverSchema }))
          .min(1)
          .max(6),
        paths: z.number().int().min(200).max(10000).optional(),
      }),
      req.body,
    );

    const baseline = buildSnapshot(profile);
    const results = body.scenarios.map((s, i) =>
      runScenario({
        profile,
        levers: s.levers as ScenarioLevers,
        label: s.label,
        id: `compare-${i}`,
        baseline,
        paths: body.paths ?? Math.max(500, Math.floor(config.simulationPaths / 2)),
      }),
    );

    res.json({
      baseline: {
        netWorthAtRetirement: baseline.retirement.projectedCorpus,
        retirementReadiness: baseline.retirement.readinessRatio,
        wellnessScore: baseline.wellness.total,
        monthlySurplus: baseline.cashflow.monthlySurplus,
        goalsOnTrack: baseline.goalProjections.filter((g) => g.onTrack).length,
        goalsTotal: baseline.goalProjections.length,
      },
      results,
    });
  }),
);

/** Projects one goal, optionally with test contributions layered on. */
router.post(
  '/:id/goals/:goalId/project',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    const profile = await store.getProfile(req.params.id as string);
    if (!profile) throw notFound('Profile');
    const goal = profile.goals.find((g) => g.id === req.params.goalId);
    if (!goal) throw notFound('Goal');

    const body = parseBody(
      z.object({
        extraMonthly: z.number().min(0).max(10_000_000).optional(),
        lumpSum: z.number().min(0).max(1_000_000_000).optional(),
        overrideReturnPct: z.number().min(-0.2).max(0.4).optional(),
      }),
      req.body ?? {},
    );

    const assumptions = resolveAssumptions(profile);
    res.json(
      projectGoal(goal, {
        annualReturn: body.overrideReturnPct ?? returnForGoal(goal, profile, assumptions),
        assumptions,
        extraMonthly: body.extraMonthly,
        lumpSum: body.lumpSum,
      }),
    );
  }),
);

/** Standalone Monte Carlo, with an optional risk-bucket override. */
router.post(
  '/:id/monte-carlo',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    const profile = await store.getProfile(req.params.id as string);
    if (!profile) throw notFound('Profile');

    const body = parseBody(
      z.object({
        years: z.number().int().min(1).max(60).optional(),
        monthlyContribution: z.number().min(0).max(10_000_000).optional(),
        riskBucket: z
          .enum(['Conservative', 'Moderate', 'Balanced', 'Growth', 'Aggressive'])
          .optional(),
        paths: z.number().int().min(200).max(20000).optional(),
        seed: z.number().int().optional(),
        realTerms: z.boolean().optional(),
      }),
      req.body ?? {},
    );

    const snapshot = buildSnapshot(profile);
    const assumptions = resolveAssumptions(profile);
    const years = body.years ?? Math.max(1, snapshot.retirement.yearsToRetirement);
    const allocation = body.riskBucket
      ? recommendAllocation(body.riskBucket, years)
      : snapshot.recommendedAllocation;
    res.json(
      runMonteCarlo({
        // The projection's own inputs, so the simulation and the funding
        // percentage shown elsewhere describe the same plan.
        startingCorpus: snapshot.retirement.plan.startingCorpus,
        monthlyContribution: body.monthlyContribution ?? snapshot.retirement.plan.monthlyContribution,
        contributionStepUpPct: snapshot.retirement.plan.stepUpPct,
        years,
        expectedReturnPct: portfolioExpectedReturn(allocation, assumptions),
        volatilityPct: portfolioVolatility(allocation, assumptions),
        target: snapshot.retirement.corpusRequired,
        paths: body.paths ?? config.simulationPaths,
        seed: body.seed,
        inflationPct: body.realTerms === false ? undefined : assumptions.inflationPct,
      }),
    );
  }),
);

/** Avalanche vs snowball, with an optional extra payment. */
router.post(
  '/:id/debt-plan',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    const profile = await store.getProfile(req.params.id as string);
    if (!profile) throw notFound('Profile');
    const body = parseBody(
      z.object({ extraMonthly: z.number().min(0).max(10_000_000).optional() }),
      req.body ?? {},
    );
    const extra = body.extraMonthly ?? 0;
    const avalanche = planDebtPayoff(profile, 'avalanche', extra);
    const snowball = planDebtPayoff(profile, 'snowball', extra);
    res.json({
      avalanche,
      snowball,
      interestSaved: snowball.totalInterestPaid - avalanche.totalInterestPaid,
      monthsSaved: snowball.monthsToDebtFree - avalanche.monthsToDebtFree,
    });
  }),
);

/** Allocation for a given risk level and horizon - drives the comparison UI. */
router.get(
  '/:id/allocation',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    const profile = await store.getProfile(req.params.id as string);
    if (!profile) throw notFound('Profile');

    const assumptions = resolveAssumptions(profile);
    const buckets = ['Conservative', 'Moderate', 'Balanced', 'Growth', 'Aggressive'] as const;
    const years = Number(req.query.years) || planningHorizon(profile);

    res.json(
      buckets.map((bucket) => {
        const weights = recommendAllocation(bucket, years);
        return {
          bucket,
          weights,
          expectedReturnPct: portfolioExpectedReturn(weights, assumptions),
          volatilityPct: portfolioVolatility(weights, assumptions),
        };
      }),
    );
  }),
);

/**
 * What following the top-ranked actions is actually worth.
 *
 * The engine could always compute this - rank actions, apply them, re-score the
 * plan - and nothing ever put the three together. `top` bounds how many of the
 * *applicable* actions are counted; the rest come back in `notModelled` so the
 * headline figure can never quietly absorb advice the platform cannot carry out.
 */
router.get(
  '/:id/impact',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    const profile = await store.getProfile(req.params.id as string);
    if (!profile) throw notFound('Profile');

    const requested = Number(req.query.top);
    const topN = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 10) : 3;

    res.json(computeActionImpact({ profile, topN }));
  }),
);

/**
 * How the money available each month should be split across the goals.
 *
 * The pool is free surplus **plus what the goals already receive**, because the
 * interesting question is rarely "where does the spare money go" - most plans
 * have none - but "is the money already committed pointed at the right goals".
 * `surplusOverride` answers the what-if without touching the stored plan.
 */
router.post(
  '/:id/optimise-goals',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    const profile = await store.getProfile(req.params.id as string);
    if (!profile) throw notFound('Profile');

    const body = parseBody(
      z.object({ surplusOverride: z.number().min(0).max(100_000_000).optional() }),
      req.body ?? {},
    );

    res.json(optimiseGoalFunding({ profile, surplusOverride: body.surplusOverride }));
  }),
);
