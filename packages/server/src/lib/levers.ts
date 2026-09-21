import { z } from 'zod';

/**
 * Scenario levers, validated once for every way a scenario can be requested.
 *
 * The HTTP route validated these; the agent's `simulate_scenario` and
 * `compare_scenarios` tools passed the model's numbers straight to the engine.
 * A model writing a 35% crash as `-35` rather than `-0.35` produced a negative
 * retirement corpus that was narrated to the user as a result. One schema for
 * both paths means a lever the API would reject cannot reach the engine
 * through the agent either.
 */

const weight = z.number().finite().min(0).max(1);

/**
 * A custom allocation. Keys are the six asset classes and nothing else - this
 * was `z.record(z.string(), ...)`, so `{"stocks": 1}` normalised to an empty
 * portfolio and every figure came back at a 0% return.
 */
export const allocationLeverSchema = z
  .object({
    equity_domestic: weight,
    equity_international: weight,
    debt: weight,
    gold: weight,
    reit: weight,
    cash: weight,
  })
  .partial()
  .strict()
  .refine((w) => Object.values(w).some((v) => (v ?? 0) > 0), {
    message: 'An allocation needs at least one asset class with a positive weight',
  });

export const leverSchema = z.object({
  extraMonthlySavings: z.number().min(0).max(10_000_000).optional(),
  expenseMultiplier: z.number().min(0.1).max(3).optional(),
  retirementAgeDelta: z.number().int().min(-30).max(30).optional(),
  allocation: allocationLeverSchema.optional(),
  incomeGrowthPct: z.number().min(0).max(1).optional(),
  lumpSum: z.number().min(0).max(1_000_000_000).optional(),
  marketShockPct: z.number().min(-0.9).max(0.9).optional(),
  shockYear: z.number().min(0).max(60).optional(),
  careerBreakMonths: z.number().int().min(0).max(120).optional(),
  inflationPct: z.number().min(0).max(0.5).optional(),
});

export type ValidatedLevers = z.infer<typeof leverSchema>;
