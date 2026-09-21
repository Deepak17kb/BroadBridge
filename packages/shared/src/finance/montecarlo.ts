import type { Assumption, MonteCarloBand, MonteCarloResult } from '../types.js';
import { createNormalSampler, createRng, percentile, round } from './math.js';

export interface MonteCarloInput {
  startingCorpus: number;
  monthlyContribution: number;
  contributionStepUpPct: number;
  years: number;
  /** Expected nominal annual return of the chosen allocation. */
  expectedReturnPct: number;
  /** Annual standard deviation of the chosen allocation. */
  volatilityPct: number;
  /** Nominal amount the run is scored against for the success probability. */
  target: number;
  paths?: number;
  seed?: number;
  /** When set, results are deflated to today's purchasing power. */
  inflationPct?: number;
  /** One-off proportional shock, e.g. -0.35, applied at `shockYear`. */
  shockPct?: number;
  shockYear?: number;
  /** Months at the start with no contribution (career break), as in `accumulate`. */
  skipMonths?: number;
}

/**
 * Geometric Brownian Motion on monthly steps.
 *
 * We sample log-returns so the corpus can never go negative, and we subtract
 * the variance drag (-s^2/2) from the drift so the *arithmetic* mean of the
 * simulated returns matches the expected return the user was shown. Skipping
 * that correction is the single most common bug in retirement simulators: it
 * silently inflates the median outcome by several percent a year.
 *
 * The run is seeded, so the same inputs always produce the same fan chart -
 * important when an AI recommendation cites a success probability.
 */
export function runMonteCarlo(input: MonteCarloInput): MonteCarloResult {
  const paths = Math.max(200, Math.min(20000, input.paths ?? 2000));
  const seed = input.seed ?? 20260920;
  /*
   * The horizon is simulated in whole months, not rounded up to whole years.
   * Rounding up ran a goal due in 1.3 years for two full years of growth and
   * contributions against a target inflated for 1.3, which overstated the
   * success probability of exactly the near-term goals it matters most for.
   */
  const months = Math.max(1, Math.round(input.years * 12));
  const horizonYears = months / 12;
  // One checkpoint per whole year, plus the exact horizon when it falls mid-year.
  const checkpoints = Array.from({ length: Math.floor(months / 12) }, (_, i) => (i + 1) * 12);
  if (months % 12 !== 0) checkpoints.push(months);
  const checkpointRow = new Map(checkpoints.map((month, idx) => [month, idx]));

  const rng = createRng(seed);
  const normal = createNormalSampler(rng);

  const sigmaMonthly = input.volatilityPct / Math.sqrt(12);
  const muMonthly = Math.log(1 + input.expectedReturnPct) / 12 - (sigmaMonthly * sigmaMonthly) / 2;
  /*
   * The shock lands at the same moment `accumulate` applies it: after month
   * `shockYear * 12` has finished, so a shock in year 3 hits the corpus at the
   * end of month 36 and one at the horizon hits the final value. This used to
   * fire a month late, which meant a crash in the final year of accumulation -
   * the worst case the deterministic projection models - was never applied.
   */
  const shockMonth =
    input.shockPct !== undefined && input.shockYear !== undefined
      ? Math.round(input.shockYear * 12)
      : null;
  const skipMonths = Math.max(0, Math.round(input.skipMonths ?? 0));

  // rows[c] holds every path's corpus at checkpoint c.
  const rows: number[][] = checkpoints.map(() => new Array(paths).fill(0));
  const terminal = new Array<number>(paths);

  for (let p = 0; p < paths; p++) {
    let corpus = input.startingCorpus;
    // A shock at or before time zero lands before anything compounds.
    if (shockMonth !== null && shockMonth <= 0) corpus *= 1 + (input.shockPct ?? 0);
    let contribution = input.monthlyContribution;
    for (let m = 0; m < months; m++) {
      if (m > 0 && m % 12 === 0) contribution *= 1 + input.contributionStepUpPct;
      const growth = Math.exp(muMonthly + sigmaMonthly * normal());
      corpus = corpus * growth + (m < skipMonths ? 0 : contribution);
      if (shockMonth !== null && m + 1 === shockMonth) corpus *= 1 + (input.shockPct ?? 0);
      const rowIdx = checkpointRow.get(m + 1);
      if (rowIdx !== undefined) {
        const row = rows[rowIdx];
        if (row) row[p] = corpus;
      }
    }
    terminal[p] = corpus;
  }

  const deflator = (year: number) =>
    input.inflationPct ? Math.pow(1 + input.inflationPct, -year) : 1;

  const bands: MonteCarloBand[] = rows.map((values, idx) => {
    const yearsIn = (checkpoints[idx] ?? months) / 12;
    const d = deflator(yearsIn);
    return {
      year: round(yearsIn, 2),
      p10: round(percentile(values, 0.1) * d, 0),
      p25: round(percentile(values, 0.25) * d, 0),
      p50: round(percentile(values, 0.5) * d, 0),
      p75: round(percentile(values, 0.75) * d, 0),
      p90: round(percentile(values, 0.9) * d, 0),
    };
  });

  const successes = terminal.filter((v) => v >= input.target).length;
  const finalDeflator = deflator(horizonYears);

  // 16 equal-width buckets between the 2nd and 98th percentile keeps the
  // histogram readable - a raw min/max range is dominated by one lucky path.
  const lo = percentile(terminal, 0.02);
  const hi = percentile(terminal, 0.98);
  const bucketCount = 16;
  const width = (hi - lo) / bucketCount || 1;
  const histogram = Array.from({ length: bucketCount }, (_, i) => ({
    bucketStart: round((lo + i * width) * finalDeflator, 0),
    bucketEnd: round((lo + (i + 1) * width) * finalDeflator, 0),
    count: 0,
  }));
  for (const v of terminal) {
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((v - lo) / width)));
    const bucket = histogram[idx];
    if (bucket) bucket.count += 1;
  }

  const assumptions: Assumption[] = [
    {
      label: 'Simulation',
      value: `${paths.toLocaleString('en-US')} paths, geometric Brownian motion on monthly steps, seed ${seed} (reproducible)`,
      source: 'model_default',
    },
    {
      label: 'Return / volatility',
      value: `${(input.expectedReturnPct * 100).toFixed(1)}% expected, ${(input.volatilityPct * 100).toFixed(1)}% annual volatility`,
      source: 'derived',
    },
    {
      label: 'Drift correction',
      value: 'Variance drag (-σ²/2) removed so the mean simulated return matches the stated expected return',
      source: 'model_default',
    },
    ...(shockMonth !== null && input.shockPct
      ? [
          {
            label: 'Simulated shock',
            value: `${(input.shockPct * 100).toFixed(0)}% one-off move at year ${input.shockYear}, on every path`,
            source: 'user_input' as const,
          },
        ]
      : []),
    ...(skipMonths > 0
      ? [
          {
            label: 'Contribution pause',
            value: `No contributions for the first ${skipMonths} months, on every path`,
            source: 'user_input' as const,
          },
        ]
      : []),
    {
      label: 'Reported in',
      value: input.inflationPct
        ? `Today’s money (deflated at ${(input.inflationPct * 100).toFixed(1)}%/yr)`
        : 'Nominal money (not inflation-adjusted)',
      source: 'model_default',
    },
    {
      label: 'Not modelled',
      value: 'Taxes, transaction costs, fat tails and return autocorrelation - real outcomes have wider extremes',
      source: 'model_default',
    },
  ];

  return {
    paths,
    seed,
    bands,
    successProbability: round(successes / paths, 4),
    median: round(percentile(terminal, 0.5) * finalDeflator, 0),
    p10: round(percentile(terminal, 0.1) * finalDeflator, 0),
    p90: round(percentile(terminal, 0.9) * finalDeflator, 0),
    target: round(input.target * finalDeflator, 0),
    histogram,
    assumptions,
  };
}
