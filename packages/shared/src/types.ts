/**
 * Domain contracts shared by the React client, the Node API and the agent tools.
 *
 * Everything the platform computes flows through these shapes, which is what lets
 * the browser run instant "what-if" maths locally while the agent runs the exact
 * same engine server-side and gets identical numbers.
 */

/**
 * The platform is INR-only. Kept as a named single-member type rather than
 * deleted: every profile and formatter still carries it, and narrowing it here
 * is what lets the compiler prove no second currency exists anywhere.
 */
export type Currency = 'INR';

export type RiskBucket = 'Conservative' | 'Moderate' | 'Balanced' | 'Growth' | 'Aggressive';

export type AssetClass =
  | 'equity_domestic'
  | 'equity_international'
  | 'debt'
  | 'gold'
  | 'reit'
  | 'cash';

export type GoalKind =
  | 'retirement'
  | 'home'
  | 'education'
  | 'vehicle'
  | 'travel'
  | 'emergency'
  | 'wealth'
  | 'custom';

export type GoalPriority = 'must_have' | 'important' | 'aspirational';

/** A single funding target the user is saving towards. */
export interface Goal {
  id: string;
  name: string;
  kind: GoalKind;
  /** Cost in *today's* money. The engine inflates it to the target date. */
  targetAmountToday: number;
  targetYear: number;
  /** Amount already earmarked for this goal. */
  currentSaved: number;
  monthlyContribution: number;
  /** Annual increase applied to the contribution, e.g. 0.1 for a 10% step-up. */
  contributionStepUpPct: number;
  priority: GoalPriority;
  /** Overrides the profile-level inflation assumption when the goal inflates faster (education, healthcare). */
  inflationOverridePct?: number;
  notes?: string;
}

export interface Holding {
  id: string;
  symbol: string;
  name: string;
  assetClass: AssetClass;
  units: number;
  /** Latest price per unit, in the profile currency. */
  price: number;
  costBasis: number;
  /** Annual fund expense ratio as a decimal, e.g. 0.0045 for 0.45%. */
  expenseRatioPct?: number;
  account?: string;
  /**
   * Concentration risk depends on what the position actually is. A 30% holding
   * in an index fund is diversified internally; a 30% holding in one stock is
   * not; a 30% holding in a provident fund is neither risky nor tradeable.
   * Defaults to `fund`, the conservative reading.
   */
  instrumentKind?: 'fund' | 'security' | 'deposit';
}

export interface Liability {
  id: string;
  name: string;
  kind: 'home_loan' | 'car_loan' | 'personal_loan' | 'credit_card' | 'education_loan' | 'other';
  outstanding: number;
  /** Annual nominal interest rate as a decimal, e.g. 0.42 for a 42% APR card. */
  interestRatePct: number;
  emi: number;
  remainingMonths?: number;
}

export interface IncomeExpense {
  monthlyNetIncome: number;
  otherMonthlyIncome: number;
  /** Category -> monthly amount. Free-form so the onboarding wizard can add rows. */
  monthlyExpenses: Record<string, number>;
  /** Expected annual salary growth as a decimal. */
  annualIncomeGrowthPct: number;
}

export interface RiskAnswers {
  /** 0-based index of the chosen option for each questionnaire item, keyed by question id. */
  [questionId: string]: number;
}

export interface RiskProfile {
  /** 0-100 behavioural willingness to take risk. */
  toleranceScore: number;
  /** 0-100 structural ability to absorb risk (horizon, income stability, dependents, buffer). */
  capacityScore: number;
  /** min(tolerance, capacity) - we never recommend past the lower of the two. */
  effectiveScore: number;
  bucket: RiskBucket;
  /** Human-readable reasons, surfaced verbatim in the UI. */
  drivers: string[];
}

export interface UserProfile {
  id: string;
  displayName: string;
  email?: string;
  age: number;
  retirementAge: number;
  dependents: number;
  /** Drives the risk-capacity score. */
  incomeStability: 'stable' | 'variable' | 'uncertain';
  currency: Currency;
  cashflow: IncomeExpense;
  /** Cash + liquid funds held outside `holdings`. */
  liquidSavings: number;
  holdings: Holding[];
  liabilities: Liability[];
  goals: Goal[];
  riskAnswers: RiskAnswers;
  /** Overrides for the global market assumptions, set on the Assumptions screen. */
  assumptionOverrides?: Partial<MarketAssumptions>;
  /** Existing annual insurance cover, used by the protection-gap check. */
  lifeInsuranceCover?: number;
  healthInsuranceCover?: number;
  createdAt: string;
  updatedAt: string;
  /** Always true in this build - the platform ships with synthetic data only. */
  isSynthetic: boolean;
}

/** Every number the engine is allowed to assume. Surfaced in the UI and in every explanation. */
export interface MarketAssumptions {
  inflationPct: number;
  riskFreePct: number;
  /** Per-asset-class expected nominal annual return. */
  expectedReturns: Record<AssetClass, number>;
  /** Per-asset-class annual standard deviation. */
  volatility: Record<AssetClass, number>;
  /** Pairwise correlations, keyed `${a}|${b}`. Symmetric; missing pairs default to 0. */
  correlations: Record<string, number>;
  /** Safe withdrawal rate used for retirement-corpus sizing. */
  safeWithdrawalRatePct: number;
  /** Months of expenses considered a complete emergency fund. */
  emergencyFundMonths: number;

  /*
   * Health-cover need model.
   *
   * Separate constants rather than one blended rule because the two drivers are
   * genuinely different: cover scales with income (a larger household spends
   * more on treatment and loses more when earnings stop), but it also has an
   * age-dependent floor, since the cost of a single hospital stay does not fall
   * just because the patient earns little. The target is the higher of the two,
   * then raised per dependent. All five are editable in the Assumptions ledger.
   */

  /** Target cover as a multiple of annual income. */
  healthCoverIncomeMultiple: number;
  /** Absolute floor below age `HEALTH_COVER_AGE_BANDS.youngMaxAge`. */
  healthCoverFloorUnder40: number;
  /** Absolute floor between the two age-band boundaries. */
  healthCoverFloor40To55: number;
  /** Absolute floor above `HEALTH_COVER_AGE_BANDS.midMaxAge`. */
  healthCoverFloorOver55: number;
  /** Added to the target for each dependent. */
  healthCoverPerDependent: number;

  /*
   * Goal-funding priority.
   *
   * When goals compete for one surplus, something has to decide the order. These
   * weights are that decision, made explicit and editable rather than buried in
   * the optimiser: a user who thinks a house deposit matters as much as
   * retirement can say so, and watch the allocation change.
   */

  /** Multiplier on a `must_have` goal's funding score. */
  goalWeightMustHave: number;
  /** Multiplier on an `important` goal's funding score. */
  goalWeightImportant: number;
  /** Multiplier on an `aspirational` goal's funding score. */
  goalWeightAspirational: number;
  /**
   * A goal this close to its target date funds before longer-horizon goals of
   * equal priority, whatever the scores say - a near-term goal cannot be
   * rescued later, and there is no compounding left to make up the difference.
   */
  nearTermGoalMonths: number;
}

export type AllocationWeights = Record<AssetClass, number>;

/* -------------------------------------------------------------------------- */
/* Engine outputs                                                              */
/* -------------------------------------------------------------------------- */

export interface Assumption {
  label: string;
  value: string;
  /** Where the number came from, so nothing looks like magic. */
  source: 'user_input' | 'market_assumption' | 'model_default' | 'derived';
}

export interface GoalProjection {
  goalId: string;
  goalName: string;
  yearsToGoal: number;
  /** Target cost inflated to the goal year. */
  inflatedTarget: number;
  /** Projected corpus at the goal date on current behaviour. */
  projectedCorpus: number;
  /** projectedCorpus - inflatedTarget. Negative means a shortfall. */
  surplus: number;
  /** 0-1. Ratio of projected corpus to the inflated target, capped at 1. */
  fundedRatio: number;
  /** Contribution that would exactly fund the goal, given the same step-up. */
  requiredMonthly: number;
  /** requiredMonthly - monthlyContribution, floored at 0. */
  monthlyGap: number;
  /** Return that would close the gap with the current contribution, or null if unreachable. */
  requiredReturnPct: number | null;
  assumedReturnPct: number;
  onTrack: boolean;
  assumptions: Assumption[];
}

export interface MonteCarloBand {
  year: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface MonteCarloResult {
  paths: number;
  seed: number;
  bands: MonteCarloBand[];
  /** Share of simulated paths that finish at or above the inflated target. */
  successProbability: number;
  median: number;
  p10: number;
  p90: number;
  /** Nominal target the run was scored against. */
  target: number;
  /** Distribution of terminal values, for the histogram. */
  histogram: { bucketStart: number; bucketEnd: number; count: number }[];
  assumptions: Assumption[];
}

export interface PortfolioAnalysis {
  totalValue: number;
  /** Realised weights derived from live holding values. */
  weights: AllocationWeights;
  expectedReturnPct: number;
  volatilityPct: number;
  sharpeRatio: number;
  /** Weighted average expense ratio across holdings that report one. */
  blendedExpenseRatioPct: number;
  /** Herfindahl index over individual positions: 1 = single holding. */
  concentrationIndex: number;
  /** Effective number of independent positions: 1 / HHI. */
  effectivePositions: number;
  largestPosition: { name: string; weight: number } | null;
  /** Largest *single-security* position - the one that actually carries idiosyncratic risk. */
  largestSingleSecurity: { name: string; weight: number } | null;
  /** 0-100, blends asset-class spread, position breadth and single-name concentration. */
  diversificationScore: number;
  unrealisedGain: number;
  drift: {
    assetClass: AssetClass;
    current: number;
    target: number;
    deltaPct: number;
    tradeAmount: number;
  }[];
  /** Sum of absolute drift, in percentage points. */
  totalDriftPct: number;
  rebalanceTrades: { assetClass: AssetClass; action: 'buy' | 'sell'; amount: number }[];
  assumptions: Assumption[];
}

export interface CashflowSummary {
  monthlyIncome: number;
  monthlyExpenses: number;
  monthlySurplus: number;
  savingsRatePct: number;
  totalEmi: number;
  /** EMI as a share of net income - lenders get nervous past ~0.4. */
  debtToIncomeRatio: number;
  emergencyFundMonths: number;
  emergencyFundTarget: number;
  emergencyFundGap: number;
  expenseBreakdown: { category: string; amount: number; sharePct: number }[];
}

export interface NetWorthSummary {
  assets: number;
  liabilities: number;
  netWorth: number;
  liquidAssets: number;
  investedAssets: number;
}

export interface RetirementReadiness {
  yearsToRetirement: number;
  /** Annual spend at retirement, inflated. */
  targetAnnualSpend: number;
  corpusRequired: number;
  projectedCorpus: number;
  /** 0-1, projected / required. */
  readinessRatio: number;
  monthlyGap: number;
  /** Age at which the projected corpus runs dry, or null if it survives to 100. */
  depletionAge: number | null;
  /**
   * The exact inputs this projection used.
   *
   * Published so a Monte Carlo run can simulate *the same plan* with market
   * randomness layered on. Without this the simulation reconstructs the inputs
   * itself and drifts - which produced a screen reading "78% funded" beside
   * "1% of paths reach the target", because the two were modelling different
   * contribution streams.
   */
  plan: {
    startingCorpus: number;
    monthlyContribution: number;
    stepUpPct: number;
    years: number;
    expectedReturnPct: number;
  };
  assumptions: Assumption[];
}

export type ActionCategory =
  | 'protection'
  | 'debt'
  | 'savings'
  | 'investing'
  | 'tax'
  | 'goals'
  | 'efficiency';

export interface NextBestAction {
  id: string;
  title: string;
  category: ActionCategory;
  /** One-sentence plain-language rationale. */
  why: string;
  /** What changes if the user does it, quantified. */
  impact: { metric: string; value: number; unit: 'currency' | 'percent' | 'months' | 'years' };
  effort: 'low' | 'medium' | 'high';
  /** 0-100 ranking score: impact x urgency x confidence. */
  priorityScore: number;
  steps: string[];
  assumptions: Assumption[];
  /**
   * Every figure this action's own wording quotes, keyed by label.
   *
   * The narration layer restates these in prose, and the agent's grounding
   * verifier checks each restated number against a tool output. Without this,
   * a correct engine-derived figure would be flagged as unverified purely
   * because it was computed inside a rule rather than returned by a tool.
   */
  evidence?: Record<string, number>;
  /** Machine-readable mutation the UI can apply with one click. */
  apply?:
    | { type: 'increase_goal_contribution'; goalId: string; amount: number }
    | { type: 'set_emergency_fund'; amount: number }
    | { type: 'rebalance_to_target' }
    | { type: 'set_allocation'; weights: AllocationWeights }
    /**
     * Sets several goal contributions at once, as the optimiser's split.
     *
     * Distinct from repeated `increase_goal_contribution` calls because the
     * optimiser's answer is a *reallocation*: some goals go up, others come
     * down, and applying it as a series of increases would only ever add.
     */
    | { type: 'set_goal_contributions'; allocations: { goalId: string; monthly: number }[] };
}

export interface DebtPayoffPlan {
  strategy: 'avalanche' | 'snowball';
  monthsToDebtFree: number;
  totalInterestPaid: number;
  order: { liabilityId: string; name: string; payoffMonth: number; interestPaid: number }[];
  /** False when at least one debt never clears at the payments provided. */
  clearsEverything: boolean;
  /**
   * Debts whose payment does not cover their own interest, so the balance grows
   * rather than shrinking. Reported separately because projecting one forward
   * produces an astronomically large and meaningless interest figure, and
   * because the useful output is the shortfall, not a payoff date.
   */
  unpayable: {
    liabilityId: string;
    name: string;
    /** Extra per month needed just to stop the balance growing. */
    monthlyShortfall: number;
    interestRatePct: number;
  }[];
}

export interface WellnessScore {
  /** 0-100 composite. */
  total: number;
  grade: 'A' | 'B' | 'C' | 'D';
  pillars: {
    name: 'Protection' | 'Cashflow' | 'Debt' | 'Investing' | 'Goals';
    score: number;
    weight: number;
    summary: string;
    /** False when the inputs this pillar needs are absent, so its score is not meaningful. */
    scored: boolean;
  }[];
  /**
   * True only when every pillar had the inputs it needs.
   *
   * An empty profile used to score 52/100 grade C, because "no debt" and "no
   * goals" both scored full marks. A confident grade on absent data is worse
   * than no grade, so the UI presents an unscored plan as incomplete.
   */
  dataComplete: boolean;
  /** What the user still needs to enter, in plain language. */
  missing: string[];
}

/** Everything the dashboard needs, computed in one pass. */
export interface FinancialSnapshot {
  profileId: string;
  currency: Currency;
  generatedAt: string;
  netWorth: NetWorthSummary;
  cashflow: CashflowSummary;
  portfolio: PortfolioAnalysis;
  risk: RiskProfile;
  recommendedAllocation: AllocationWeights;
  goalProjections: GoalProjection[];
  retirement: RetirementReadiness;
  wellness: WellnessScore;
  actions: NextBestAction[];
  assumptions: MarketAssumptions;
}

/* -------------------------------------------------------------------------- */
/* Scenarios                                                                   */
/* -------------------------------------------------------------------------- */

/** The levers the Scenario Lab exposes. All optional - unset means "keep as-is". */
export interface ScenarioLevers {
  extraMonthlySavings?: number;
  /** Multiplier on every expense category, e.g. 0.9 to cut spending 10%. */
  expenseMultiplier?: number;
  retirementAgeDelta?: number;
  /** Replaces the portfolio allocation for the projection. */
  allocation?: AllocationWeights;
  /** Absolute annual salary growth override. */
  incomeGrowthPct?: number;
  /** One-off lump sum invested today (bonus, maturity, sale proceeds). */
  lumpSum?: number;
  /** Simulated market crash: a one-off drawdown applied in `shockYear`. */
  marketShockPct?: number;
  shockYear?: number;
  /** Career break in months, during which contributions stop. */
  careerBreakMonths?: number;
  inflationPct?: number;
}

export interface ScenarioResult {
  id: string;
  label: string;
  levers: ScenarioLevers;
  snapshot: {
    netWorthAtRetirement: number;
    retirementReadiness: number;
    wellnessScore: number;
    monthlySurplus: number;
    goalsOnTrack: number;
    goalsTotal: number;
    /** The allocation's expected return, surfaced because the narration quotes it. */
    expectedReturnPct: number;
    volatilityPct: number;
  };
  goalProjections: GoalProjection[];
  monteCarlo: MonteCarloResult;
  /** Deltas versus the baseline, pre-computed so the UI stays dumb. */
  deltaVsBaseline: {
    netWorthAtRetirement: number;
    retirementReadiness: number;
    wellnessScore: number;
    goalsOnTrack: number;
  };
  explanation: string;
  assumptions: Assumption[];
}

/* -------------------------------------------------------------------------- */
/* Agent protocol                                                              */
/* -------------------------------------------------------------------------- */

export type AgentEvent =
  | { type: 'run_started'; runId: string; at: string }
  | { type: 'plan'; steps: AgentPlanStep[]; rationale: string }
  | { type: 'thought'; text: string }
  | { type: 'tool_call'; id: string; tool: string; input: unknown; label: string }
  | { type: 'tool_result'; id: string; tool: string; summary: string; data: unknown; ms: number }
  | { type: 'retrieval'; query: string; hits: { title: string; score: number; snippet: string }[] }
  | { type: 'token'; text: string }
  | { type: 'verification'; checks: VerificationCheck[] }
  | { type: 'final'; message: AgentMessage }
  | { type: 'error'; message: string; recoverable: boolean };

export interface AgentPlanStep {
  id: string;
  /** Tool the planner intends to call, or `synthesize` for the final answer. */
  tool: string;
  goal: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'failed';
}

export interface VerificationCheck {
  claim: string;
  status: 'grounded' | 'unverified';
  evidence: string;
}

export interface Citation {
  /** Tool call or knowledge-base document backing a statement. */
  kind: 'tool' | 'knowledge';
  ref: string;
  label: string;
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at: string;
  /** Populated on assistant turns. */
  citations?: Citation[];
  assumptions?: Assumption[];
  plan?: AgentPlanStep[];
  toolCalls?: { tool: string; label: string; ms: number }[];
  verification?: VerificationCheck[];
  /** Structured payloads the chat UI renders as cards instead of prose. */
  attachments?: AgentAttachment[];
  /** Which reasoning engine produced this turn. */
  engine?: 'bedrock' | 'anthropic' | 'groq' | 'deterministic';
}

export type AgentAttachment =
  | { kind: 'goal_projection'; data: GoalProjection }
  | { kind: 'monte_carlo'; data: MonteCarloResult }
  | { kind: 'scenario'; data: ScenarioResult }
  | { kind: 'portfolio'; data: PortfolioAnalysis }
  | { kind: 'actions'; data: NextBestAction[] }
  | { kind: 'allocation'; data: { current: AllocationWeights; recommended: AllocationWeights } }
  | { kind: 'debt_plan'; data: DebtPayoffPlan };

export interface ChatSession {
  id: string;
  profileId: string;
  messages: AgentMessage[];
  createdAt: string;
  updatedAt: string;
}
