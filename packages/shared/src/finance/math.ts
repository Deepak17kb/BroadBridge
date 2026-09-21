/**
 * Numeric primitives for the planning engine.
 *
 * Two rules hold everywhere in this file:
 *  1. Annual rates are converted to monthly *geometrically* - (1+r)^(1/12)-1,
 *     not r/12. The naive division overstates a 12% portfolio by ~0.6%/yr,
 *     which compounds into a materially wrong 25-year number.
 *  2. Randomness is seeded. Every simulation is reproducible, so a
 *     recommendation the agent made ten minutes ago can be re-derived exactly.
 */

/** Geometric annual -> monthly rate. */
export function monthlyRate(annualRate: number): number {
  return Math.pow(1 + annualRate, 1 / 12) - 1;
}

/** Future value of `n` end-of-month payments of 1 at monthly rate `i`. */
export function annuityFactor(i: number, n: number): number {
  if (n <= 0) return 0;
  if (Math.abs(i) < 1e-12) return n;
  return (Math.pow(1 + i, n) - 1) / i;
}

/**
 * Future value of a contribution stream that steps up once a year.
 *
 * Returns the FV of a *unit* monthly contribution (1 currency unit in year 1)
 * over `years`, so callers can scale linearly: FV = contribution * factor.
 * That linearity is what makes `requiredMonthlyContribution` exact rather than
 * an iterative search.
 */
export function steppedAnnuityFactor(
  annualReturn: number,
  years: number,
  stepUpPct: number,
  /** Months at the start during which no contribution is made (career break). */
  skipMonths = 0,
): number {
  const i = monthlyRate(annualReturn);
  const wholeYears = Math.floor(years);
  const stubMonths = Math.round((years - wholeYears) * 12);
  const totalMonths = wholeYears * 12 + stubMonths;
  let factor = 0;

  for (let y = 0; y < wholeYears; y++) {
    const yearMultiplier = Math.pow(1 + stepUpPct, y);
    for (let m = 0; m < 12; m++) {
      const monthIndex = y * 12 + m;
      if (monthIndex < skipMonths) continue;
      // Contribution lands at the end of this month, then compounds for the rest.
      const monthsRemaining = totalMonths - monthIndex - 1;
      factor += yearMultiplier * Math.pow(1 + i, monthsRemaining);
    }
  }
  const stubMultiplier = Math.pow(1 + stepUpPct, wholeYears);
  for (let m = 0; m < stubMonths; m++) {
    const monthIndex = wholeYears * 12 + m;
    if (monthIndex < skipMonths) continue;
    const monthsRemaining = totalMonths - monthIndex - 1;
    factor += stubMultiplier * Math.pow(1 + i, monthsRemaining);
  }
  return factor;
}

/** Future value of an existing lump sum. */
export function futureValueLumpSum(present: number, annualReturn: number, years: number): number {
  return present * Math.pow(1 + annualReturn, years);
}

/**
 * Contribution needed to reach `target`, given a starting corpus.
 * Exact, because FV is linear in the contribution.
 */
export function requiredMonthlyContribution(
  target: number,
  currentCorpus: number,
  annualReturn: number,
  years: number,
  stepUpPct: number,
): number {
  if (years <= 0) return Math.max(0, target - currentCorpus);
  const fromCorpus = futureValueLumpSum(currentCorpus, annualReturn, years);
  const shortfall = target - fromCorpus;
  if (shortfall <= 0) return 0;
  const factor = steppedAnnuityFactor(annualReturn, years, stepUpPct);
  if (factor <= 0) return shortfall;
  return shortfall / factor;
}

/**
 * Annual return that would make a fixed contribution stream hit `target`.
 * Bisection on a monotonically increasing function; null when even 40%/yr
 * cannot get there (the honest answer is "no return will fix this").
 */
export function solveRequiredReturn(
  target: number,
  currentCorpus: number,
  monthlyContribution: number,
  years: number,
  stepUpPct: number,
): number | null {
  if (years <= 0) return null;
  const fv = (r: number) =>
    futureValueLumpSum(currentCorpus, r, years) +
    monthlyContribution * steppedAnnuityFactor(r, years, stepUpPct);

  let lo = -0.5;
  let hi = 0.4;
  if (fv(hi) < target) return null;
  if (fv(lo) > target) return lo;
  for (let iter = 0; iter < 80; iter++) {
    const mid = (lo + hi) / 2;
    if (fv(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface AccumulationInput {
  startingCorpus: number;
  monthlyContribution: number;
  annualReturn: number;
  years: number;
  stepUpPct: number;
  /** Months at the start with no contribution. */
  skipMonths?: number;
  /** One-off proportional move, e.g. -0.35 for a 35% drawdown. */
  shockPct?: number;
  /** Years from now at which the shock lands. */
  shockYear?: number;
}

/**
 * Closed-form accumulation with an optional one-off market shock.
 *
 * The shock is applied to the corpus *at that point in time*, so only the years
 * after it compound the loss - and contributions keep flowing throughout, which
 * is exactly why a 35% crash twenty years out costs far less than 35% of the
 * final number. Shared by goal projection and retirement sizing so the two can
 * never model a crash differently.
 */
export function accumulate(input: AccumulationInput): number {
  const { startingCorpus, monthlyContribution, annualReturn, years, stepUpPct } = input;
  const skipMonths = input.skipMonths ?? 0;

  const plain = () =>
    futureValueLumpSum(startingCorpus, annualReturn, years) +
    monthlyContribution * steppedAnnuityFactor(annualReturn, years, stepUpPct, skipMonths);

  if (input.shockPct === undefined || input.shockYear === undefined) return plain();
  const shockYear = input.shockYear;
  if (shockYear <= 0) {
    // Shock lands immediately, before anything compounds.
    return (
      futureValueLumpSum(startingCorpus * (1 + input.shockPct), annualReturn, years) +
      monthlyContribution * steppedAnnuityFactor(annualReturn, years, stepUpPct, skipMonths)
    );
  }
  /*
   * A shock landing exactly at the horizon is the *worst* case, not a no-op:
   * the whole corpus takes the hit with no time left to recover. Only a shock
   * scheduled beyond the horizon is irrelevant.
   *
   * This read `>=` originally, which silently discarded the single most
   * damaging scenario the platform can model - a crash in the final year of
   * accumulation, which is exactly the sequencing risk the knowledge base warns
   * about. It reported a 50% drawdown as zero impact.
   */
  if (shockYear > years) return plain();

  const yearsAfter = years - shockYear;
  const atShock =
    futureValueLumpSum(startingCorpus, annualReturn, shockYear) +
    monthlyContribution * steppedAnnuityFactor(annualReturn, shockYear, stepUpPct, skipMonths);
  const afterShock = atShock * (1 + input.shockPct);
  // Contributions resume at whatever level the step-up had reached by the shock.
  const contributionAtShock = monthlyContribution * Math.pow(1 + stepUpPct, Math.floor(shockYear));
  // A career break that outlasts the shock keeps pausing contributions after
  // it. Dropping the remainder here credited a 36-month break with a year's
  // contributions whenever a crash landed in year one.
  const skipAfterShock = Math.max(0, skipMonths - Math.round(shockYear * 12));
  return (
    futureValueLumpSum(afterShock, annualReturn, yearsAfter) +
    contributionAtShock * steppedAnnuityFactor(annualReturn, yearsAfter, stepUpPct, skipAfterShock)
  );
}

/** Deterministic 32-bit PRNG (mulberry32). Same seed, same simulation, always. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller, drawing from a seeded uniform source. */
export function createNormalSampler(rng: () => number): () => number {
  let spare: number | null = null;
  return function next(): number {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    let u = rng();
    // log(0) guard - mulberry32 can return exactly 0.
    if (u < 1e-12) u = 1e-12;
    const v = rng();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}

/** Linear-interpolated percentile over an unsorted array. `p` in [0,1]. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sorted[lo] ?? 0;
  if (lo === hi) return loVal;
  const hiVal = sorted[hi] ?? loVal;
  return loVal + (hiVal - loVal) * (idx - lo);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

/** Rounds to `dp` decimals without float artefacts like 0.30000000000000004. */
export function round(value: number, dp = 2): number {
  const f = Math.pow(10, dp);
  return Math.round(value * f) / f;
}

/**
 * Months needed to clear a balance at a given EMI.
 * Returns Infinity when the payment does not even cover the interest.
 */
export function monthsToPayoff(balance: number, annualRatePct: number, payment: number): number {
  if (balance <= 0) return 0;
  const i = monthlyRate(annualRatePct);
  if (payment <= balance * i) return Infinity;
  if (i < 1e-12) return Math.ceil(balance / payment);
  return Math.ceil(-Math.log(1 - (i * balance) / payment) / Math.log(1 + i));
}

/** EMI for a loan, standard amortisation formula. */
export function emiFor(principal: number, annualRatePct: number, months: number): number {
  const i = monthlyRate(annualRatePct);
  if (months <= 0) return principal;
  if (i < 1e-12) return principal / months;
  return (principal * i * Math.pow(1 + i, months)) / (Math.pow(1 + i, months) - 1);
}
