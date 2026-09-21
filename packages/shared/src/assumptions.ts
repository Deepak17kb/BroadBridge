import type {
  AllocationWeights,
  AssetClass,
  GoalPriority,
  MarketAssumptions,
  RiskBucket,
} from './types.js';

export const ASSET_CLASSES: AssetClass[] = [
  'equity_domestic',
  'equity_international',
  'debt',
  'gold',
  'reit',
  'cash',
];

export const ASSET_LABELS: Record<AssetClass, string> = {
  equity_domestic: 'Domestic Equity',
  equity_international: 'International Equity',
  debt: 'Debt / Bonds',
  gold: 'Gold',
  reit: 'REITs',
  cash: 'Cash & Liquid',
};

/**
 * House view. These are illustrative long-run figures for a synthetic-data
 * hackathon build, not investment advice - every screen that consumes them
 * shows them, and the Assumptions page lets the user override each one.
 */
export const DEFAULT_ASSUMPTIONS: MarketAssumptions = {
  inflationPct: 0.06,
  riskFreePct: 0.066,
  expectedReturns: {
    equity_domestic: 0.12,
    equity_international: 0.1,
    debt: 0.07,
    gold: 0.08,
    reit: 0.09,
    cash: 0.04,
  },
  volatility: {
    equity_domestic: 0.18,
    equity_international: 0.16,
    debt: 0.05,
    gold: 0.15,
    reit: 0.14,
    cash: 0.01,
  },
  correlations: {
    'equity_domestic|equity_international': 0.6,
    'equity_domestic|debt': 0.1,
    'equity_domestic|gold': -0.1,
    'equity_domestic|reit': 0.55,
    'equity_domestic|cash': 0,
    'equity_international|debt': 0.15,
    'equity_international|gold': 0.05,
    'equity_international|reit': 0.45,
    'equity_international|cash': 0,
    'debt|gold': 0.2,
    'debt|reit': 0.25,
    'debt|cash': 0.3,
    'gold|reit': 0.05,
    'gold|cash': 0,
    'reit|cash': 0,
  },
  safeWithdrawalRatePct: 0.035,
  emergencyFundMonths: 6,
  healthCoverIncomeMultiple: 0.5,
  healthCoverFloorUnder40: 500_000,
  healthCoverFloor40To55: 1_000_000,
  healthCoverFloorOver55: 1_500_000,
  healthCoverPerDependent: 300_000,
  goalWeightMustHave: 1,
  goalWeightImportant: 0.6,
  goalWeightAspirational: 0.3,
  nearTermGoalMonths: 24,
};

/** The funding weight for a goal's priority, as set in the Assumptions ledger. */
export function goalPriorityWeight(
  priority: GoalPriority,
  assumptions: MarketAssumptions,
): number {
  if (priority === 'must_have') return assumptions.goalWeightMustHave;
  if (priority === 'important') return assumptions.goalWeightImportant;
  return assumptions.goalWeightAspirational;
}

/**
 * Age boundaries for the health-cover floor.
 *
 * Structural rather than a per-profile tunable: the *amounts* are what a user
 * has an opinion about and those are editable, but moving the boundary between
 * bands changes the shape of the model rather than its calibration. Exported so
 * the Assumptions ledger can state the bands it is applying instead of leaving
 * the reader to infer them from three unexplained numbers.
 */
export const HEALTH_COVER_AGE_BANDS = { youngMaxAge: 40, midMaxAge: 55 } as const;

/**
 * The absolute cover floor for an age, before income and dependents are
 * considered. Treatment costs rise with age while insurability falls, so the
 * floor steps up rather than scaling smoothly.
 */
export function healthCoverFloorForAge(age: number, assumptions: MarketAssumptions): number {
  if (age < HEALTH_COVER_AGE_BANDS.youngMaxAge) return assumptions.healthCoverFloorUnder40;
  if (age < HEALTH_COVER_AGE_BANDS.midMaxAge) return assumptions.healthCoverFloor40To55;
  return assumptions.healthCoverFloorOver55;
}

/**
 * Health cover this profile should be carrying.
 *
 *   target = max(annual income x multiple, floor for age) + per-dependent loading
 *
 * The max is the point of the model: income alone under-insures a young earner
 * whose first serious admission costs the same as anyone else's, and the floor
 * alone under-insures a high earner whose household spends far more when
 * treatment interrupts it.
 */
export function healthCoverTarget(input: {
  annualIncome: number;
  age: number;
  dependents: number;
  assumptions: MarketAssumptions;
}): number {
  const { annualIncome, age, dependents, assumptions } = input;
  const incomeBased = Math.max(0, annualIncome) * assumptions.healthCoverIncomeMultiple;
  const floor = healthCoverFloorForAge(age, assumptions);
  return Math.max(incomeBased, floor) + Math.max(0, dependents) * assumptions.healthCoverPerDependent;
}

/** Model portfolios, one per risk bucket. Weights sum to 1. */
export const MODEL_PORTFOLIOS: Record<RiskBucket, AllocationWeights> = {
  Conservative: {
    equity_domestic: 0.15,
    equity_international: 0.05,
    debt: 0.55,
    gold: 0.1,
    reit: 0.0,
    cash: 0.15,
  },
  Moderate: {
    equity_domestic: 0.3,
    equity_international: 0.1,
    debt: 0.4,
    gold: 0.1,
    reit: 0.0,
    cash: 0.1,
  },
  Balanced: {
    equity_domestic: 0.42,
    equity_international: 0.13,
    debt: 0.28,
    gold: 0.08,
    reit: 0.04,
    cash: 0.05,
  },
  Growth: {
    equity_domestic: 0.53,
    equity_international: 0.17,
    debt: 0.15,
    gold: 0.06,
    reit: 0.05,
    cash: 0.04,
  },
  Aggressive: {
    equity_domestic: 0.62,
    equity_international: 0.22,
    debt: 0.06,
    gold: 0.04,
    reit: 0.03,
    cash: 0.03,
  },
};

export const RISK_BUCKETS: RiskBucket[] = [
  'Conservative',
  'Moderate',
  'Balanced',
  'Growth',
  'Aggressive',
];

export interface RiskQuestion {
  id: string;
  prompt: string;
  /** Options are ordered from least to most risk-seeking; index maps to `scores`. */
  options: string[];
  scores: number[];
  /** Behavioural willingness vs. structural ability to take risk. */
  dimension: 'tolerance' | 'capacity';
}

/**
 * Six-question profiler. Tolerance questions measure how the user behaves under
 * stress; capacity questions measure whether their balance sheet can afford it.
 * We recommend against the *lower* of the two so nobody is talked into a
 * portfolio they will abandon in a drawdown.
 */
export const RISK_QUESTIONS: RiskQuestion[] = [
  {
    id: 'drawdown',
    prompt: 'Your portfolio drops 25% in three months. What do you actually do?',
    options: [
      'Sell everything and move to deposits',
      'Sell some to stop the bleeding',
      'Do nothing and wait it out',
      'Keep investing on schedule',
      'Invest extra - things are on sale',
    ],
    scores: [0, 25, 55, 80, 100],
    dimension: 'tolerance',
  },
  {
    id: 'experience',
    prompt: 'How would you describe your investing experience?',
    options: [
      'This is my first time',
      'I hold a couple of funds',
      'I invest regularly and track it',
      'I actively manage a diversified portfolio',
    ],
    scores: [15, 40, 70, 95],
    dimension: 'tolerance',
  },
  {
    id: 'tradeoff',
    prompt: 'Pick the portfolio you would be most comfortable holding for 10 years.',
    options: [
      'Steady 7%/yr, almost never falls',
      'Around 9%/yr, occasional 10% dips',
      'Around 11%/yr, occasional 20% dips',
      'Around 13%/yr, occasional 35% dips',
    ],
    scores: [10, 40, 70, 100],
    dimension: 'tolerance',
  },
  {
    id: 'horizon',
    prompt: 'When will you need to withdraw a meaningful part of this money?',
    options: ['Within 2 years', 'In 3-5 years', 'In 6-10 years', 'In more than 10 years'],
    scores: [5, 35, 70, 100],
    dimension: 'capacity',
  },
  {
    id: 'buffer',
    prompt: 'If your income stopped tomorrow, how long would your savings cover expenses?',
    options: ['Under 1 month', '1-3 months', '3-6 months', 'More than 6 months'],
    scores: [5, 30, 65, 100],
    dimension: 'capacity',
  },
  {
    id: 'flexibility',
    prompt: 'How much of your monthly income is committed (EMIs, rent, dependents)?',
    options: ['Almost all of it', 'Most of it', 'About half', 'Less than a third'],
    scores: [10, 35, 65, 100],
    dimension: 'capacity',
  },
];


