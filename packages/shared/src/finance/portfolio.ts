import { ASSET_CLASSES, ASSET_LABELS, MODEL_PORTFOLIOS } from '../assumptions.js';
import type {
  AllocationWeights,
  AssetClass,
  Assumption,
  Holding,
  MarketAssumptions,
  PortfolioAnalysis,
  RiskBucket,
} from '../types.js';
import { clamp, round, sum } from './math.js';

export function emptyWeights(): AllocationWeights {
  return {
    equity_domestic: 0,
    equity_international: 0,
    debt: 0,
    gold: 0,
    reit: 0,
    cash: 0,
  };
}

export function holdingValue(h: Holding): number {
  return h.units * h.price;
}

/** Correlation lookup that tolerates either key order and defaults sensibly. */
export function correlationOf(
  a: AssetClass,
  b: AssetClass,
  correlations: Record<string, number>,
): number {
  if (a === b) return 1;
  return correlations[`${a}|${b}`] ?? correlations[`${b}|${a}`] ?? 0;
}

/** Weighted expected return: simple dot product of weights and class returns. */
export function portfolioExpectedReturn(
  weights: AllocationWeights,
  assumptions: MarketAssumptions,
): number {
  return ASSET_CLASSES.reduce(
    (acc, ac) => acc + (weights[ac] ?? 0) * assumptions.expectedReturns[ac],
    0,
  );
}

/**
 * Portfolio volatility from the full covariance matrix: sqrt(w' Σ w).
 *
 * Doing this properly (rather than weighting the vols) is what lets the app
 * show that adding gold to an equity-heavy book *lowers* total risk - the
 * negative equity/gold correlation only shows up in the cross terms.
 */
export function portfolioVolatility(
  weights: AllocationWeights,
  assumptions: MarketAssumptions,
): number {
  let variance = 0;
  for (const a of ASSET_CLASSES) {
    for (const b of ASSET_CLASSES) {
      const wa = weights[a] ?? 0;
      const wb = weights[b] ?? 0;
      if (wa === 0 || wb === 0) continue;
      variance +=
        wa *
        wb *
        assumptions.volatility[a] *
        assumptions.volatility[b] *
        correlationOf(a, b, assumptions.correlations);
    }
  }
  return Math.sqrt(Math.max(0, variance));
}

export function normaliseWeights(weights: AllocationWeights): AllocationWeights {
  const total = sum(ASSET_CLASSES.map((ac) => weights[ac] ?? 0));
  if (total <= 0) return emptyWeights();
  const out = emptyWeights();
  for (const ac of ASSET_CLASSES) out[ac] = (weights[ac] ?? 0) / total;
  return out;
}

/** Live weights implied by the holdings list, plus any un-invested cash. */
export function weightsFromHoldings(holdings: Holding[], liquidSavings = 0): AllocationWeights {
  const weights = emptyWeights();
  const total = sum(holdings.map(holdingValue)) + liquidSavings;
  if (total <= 0) return weights;
  for (const h of holdings) weights[h.assetClass] += holdingValue(h) / total;
  weights.cash += liquidSavings / total;
  return weights;
}

/**
 * Glide path: the recommended mix is the model portfolio for the user's risk
 * bucket, de-risked as the horizon shortens. Under 3 years we pull equity down
 * hard regardless of appetite - sequencing risk does not care how brave you are.
 */
export function recommendAllocation(bucket: RiskBucket, yearsToHorizon: number): AllocationWeights {
  const base = MODEL_PORTFOLIOS[bucket];
  let equityHaircut = 0;
  if (yearsToHorizon < 3) equityHaircut = 0.6;
  else if (yearsToHorizon < 5) equityHaircut = 0.4;
  else if (yearsToHorizon < 8) equityHaircut = 0.2;
  else if (yearsToHorizon < 12) equityHaircut = 0.08;

  if (equityHaircut === 0) return { ...base };

  const out = { ...base };
  const movedFromDomestic = out.equity_domestic * equityHaircut;
  const movedFromIntl = out.equity_international * equityHaircut;
  const movedFromReit = out.reit * equityHaircut;
  out.equity_domestic -= movedFromDomestic;
  out.equity_international -= movedFromIntl;
  out.reit -= movedFromReit;
  const moved = movedFromDomestic + movedFromIntl + movedFromReit;
  // Short horizons want certainty: two-thirds to debt, one-third to cash.
  out.debt += moved * 0.67;
  out.cash += moved * 0.33;
  return normaliseWeights(out);
}

/**
 * Herfindahl-Hirschman index over individual positions.
 * 1.0 means one holding; 0.1 means ten equally-sized ones.
 */
export function concentrationIndex(holdings: Holding[]): number {
  const total = sum(holdings.map(holdingValue));
  if (total <= 0) return 0;
  return sum(holdings.map((h) => Math.pow(holdingValue(h) / total, 2)));
}

export function analyzePortfolio(
  holdings: Holding[],
  liquidSavings: number,
  targetWeights: AllocationWeights,
  assumptions: MarketAssumptions,
): PortfolioAnalysis {
  const investedValue = sum(holdings.map(holdingValue));
  const totalValue = investedValue + liquidSavings;
  const weights = weightsFromHoldings(holdings, liquidSavings);
  const expectedReturnPct = portfolioExpectedReturn(weights, assumptions);
  const volatilityPct = portfolioVolatility(weights, assumptions);
  const sharpeRatio =
    volatilityPct > 0 ? (expectedReturnPct - assumptions.riskFreePct) / volatilityPct : 0;

  const withFees = holdings.filter((h) => typeof h.expenseRatioPct === 'number');
  const feeBase = sum(withFees.map(holdingValue));
  const blendedExpenseRatioPct =
    feeBase > 0
      ? sum(withFees.map((h) => holdingValue(h) * (h.expenseRatioPct ?? 0))) / feeBase
      : 0;

  const hhi = concentrationIndex(holdings);
  const effectivePositions = hhi > 0 ? 1 / hhi : 0;
  const largest = holdings.reduce<Holding | null>(
    (best, h) => (!best || holdingValue(h) > holdingValue(best) ? h : best),
    null,
  );
  // Only individual securities carry idiosyncratic risk worth flagging. A large
  // index-fund or provident-fund position is not a concentration problem.
  const securities = holdings.filter((h) => h.instrumentKind === 'security');
  const largestSecurity = securities.reduce<Holding | null>(
    (best, h) => (!best || holdingValue(h) > holdingValue(best) ? h : best),
    null,
  );

  /*
   * Three independent failure modes, scored separately:
   *   spread   - how many asset classes are actually in play
   *   breadth  - how many *effective* positions there are (1/HHI, so ten equal
   *              holdings scores far better than four lopsided ones)
   *   name     - how much sits in a single security
   *
   * Scoring breadth off (1 - HHI) instead would rate a four-position portfolio
   * at 94/100, which is how these dashboards end up telling someone with a
   * third of their money in one stock that they are well diversified.
   */
  const classesUsed = ASSET_CLASSES.filter((ac) => (weights[ac] ?? 0) > 0.02).length;
  const spreadScore = clamp((classesUsed / 5) * 100, 0, 100);
  const breadthScore = clamp(((effectivePositions - 1) / 9) * 100, 0, 100);
  const securityWeight =
    largestSecurity && investedValue > 0 ? holdingValue(largestSecurity) / investedValue : 0;
  // 25% or more in one stock wipes out the single-name component entirely.
  const nameScore = clamp(100 - (securityWeight / 0.25) * 100, 0, 100);
  /*
   * Nothing invested means nothing diversified. Without this guard the
   * single-name component scores a full 100 ("no concentration risk!") and an
   * empty portfolio came out at 30/100 - a passing-looking mark for a user who
   * holds nothing at all, which then propagated into the wellness score.
   */
  const diversificationScore =
    totalValue <= 0
      ? 0
      : round(spreadScore * 0.4 + breadthScore * 0.3 + nameScore * 0.3, 0);

  const target = normaliseWeights(targetWeights);
  const drift = ASSET_CLASSES.map((ac) => {
    const current = weights[ac] ?? 0;
    const want = target[ac] ?? 0;
    return {
      assetClass: ac,
      current: round(current, 4),
      target: round(want, 4),
      deltaPct: round(current - want, 4),
      tradeAmount: round((want - current) * totalValue, 0),
    };
  });
  /*
   * Half the sum of absolute deltas, because every rupee that is overweight in
   * one class is underweight in another - counting both sides double-counts the
   * money. Halving gives the share of the portfolio that actually has to move,
   * which is a figure a reader can act on and which cannot exceed 100%.
   *
   * The raw sum reported "you have drifted 192% from target" for an all-cash
   * portfolio, which is meaningless to anyone reading % as a share.
   */
  const totalDriftPct = round((sum(drift.map((d) => Math.abs(d.deltaPct))) / 2) * 100, 1);

  // Only surface trades worth doing - sub-1% nudges are noise and cost money.
  const rebalanceTrades = drift
    .filter((d) => Math.abs(d.deltaPct) > 0.01)
    .map((d) => ({
      assetClass: d.assetClass,
      action: d.tradeAmount > 0 ? ('buy' as const) : ('sell' as const),
      amount: Math.abs(d.tradeAmount),
    }))
    .sort((a, b) => b.amount - a.amount);

  const unrealisedGain = sum(holdings.map((h) => holdingValue(h) - h.costBasis));

  const assumptionList: Assumption[] = [
    {
      label: 'Expected returns',
      value: ASSET_CLASSES.filter((ac) => (weights[ac] ?? 0) > 0.01)
        .map((ac) => `${ASSET_LABELS[ac]} ${(assumptions.expectedReturns[ac] * 100).toFixed(1)}%`)
        .join(', '),
      source: 'market_assumption',
    },
    {
      label: 'Risk-free rate',
      value: `${(assumptions.riskFreePct * 100).toFixed(2)}% (used for the Sharpe ratio)`,
      source: 'market_assumption',
    },
    {
      label: 'Volatility method',
      value: 'Full covariance matrix (w’Σw), not a weighted average of volatilities',
      source: 'model_default',
    },
    {
      label: 'Cash treatment',
      value: `Liquid savings counted as a cash allocation`,
      source: 'model_default',
    },
  ];

  return {
    totalValue: round(totalValue, 0),
    weights,
    expectedReturnPct: round(expectedReturnPct, 4),
    volatilityPct: round(volatilityPct, 4),
    sharpeRatio: round(sharpeRatio, 2),
    blendedExpenseRatioPct: round(blendedExpenseRatioPct, 5),
    concentrationIndex: round(hhi, 3),
    effectivePositions: round(effectivePositions, 2),
    largestPosition: largest
      ? {
          name: largest.name,
          weight: round(investedValue > 0 ? holdingValue(largest) / investedValue : 0, 4),
        }
      : null,
    largestSingleSecurity: largestSecurity
      ? { name: largestSecurity.name, weight: round(securityWeight, 4) }
      : null,
    diversificationScore,
    unrealisedGain: round(unrealisedGain, 0),
    drift,
    totalDriftPct,
    rebalanceTrades,
    assumptions: assumptionList,
  };
}
