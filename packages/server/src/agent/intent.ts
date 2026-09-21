import type { AgentPlanStep, UserProfile } from '@wealth/shared';

/**
 * Intent routing and heuristic planning.
 *
 * This serves two purposes. In deterministic mode it *is* the planner. In LLM
 * mode it produces the fallback plan when the planning call fails, and it seeds
 * the plan shown to the user immediately - so the trace appears within
 * milliseconds rather than after the first model round-trip.
 */

export type Intent =
  | 'overview'
  | 'goal'
  | 'whatif'
  | 'portfolio'
  | 'actions'
  | 'debt'
  | 'probability'
  | 'education'
  | 'update'
  | 'compare';

interface IntentRule {
  intent: Intent;
  /** Phrases score 3, single words score 1. */
  phrases: string[];
  words: string[];
}

const RULES: IntentRule[] = [
  {
    intent: 'update',
    phrases: [
      'increase my contribution', 'change my', 'set my', 'update my', 'add a goal',
      'apply that', 'do it', 'make that change', 'bump my', 'raise my sip',
    ],
    words: [],
  },
  {
    intent: 'whatif',
    phrases: [
      'what if', 'what happens if', 'what would happen', 'suppose i', 'if i save',
      'if i invest', 'if i retire', 'if the market', 'career break', 'lump sum',
      'should i save more', 'can i afford to',
    ],
    words: ['scenario', 'crash', 'shock', 'bonus', 'sabbatical'],
  },
  {
    intent: 'compare',
    phrases: [
      'which is better', 'compare', 'versus', ' vs ', 'better option', 'or should i',
      'which one should',
    ],
    words: ['either'],
  },
  {
    intent: 'probability',
    phrases: [
      'what are the chances', 'how likely', 'probability of', 'will i have enough',
      'risk of running out', 'confidence', 'worst case', 'best case', 'range of outcomes',
    ],
    words: ['odds', 'likelihood', 'percentile', 'simulate', 'simulation', 'montecarlo'],
  },
  {
    intent: 'debt',
    phrases: [
      'pay off', 'pay down', 'clear my', 'credit card', 'home loan', 'car loan',
      'should i prepay', 'debt free', 'personal loan', 'education loan',
    ],
    words: ['debt', 'loan', 'emi', 'prepay', 'avalanche', 'snowball', 'interest'],
  },
  {
    intent: 'portfolio',
    phrases: [
      'my portfolio', 'asset allocation', 'am i diversified', 'too much equity',
      'should i rebalance', 'my holdings', 'expense ratio', 'my funds', 'too risky',
      'risk level',
    ],
    words: ['allocation', 'rebalance', 'diversified', 'diversification', 'holdings', 'equity', 'fees', 'concentration', 'sharpe'],
  },
  {
    intent: 'actions',
    phrases: [
      'what should i do', 'where should i start', 'next steps', 'what do i do next',
      'how do i improve', 'top priority', 'most important thing', 'best use of',
      'advise me', 'recommend',
    ],
    words: ['priority', 'priorities', 'recommendation', 'recommendations', 'action', 'actions'],
  },
  {
    intent: 'goal',
    phrases: [
      'am i on track', 'on track for', 'my retirement', 'my education goal',
      'how much do i need', 'when can i retire', 'will i reach', 'enough for',
      'my goal', 'fund my',
    ],
    words: ['goal', 'goals', 'retirement', 'retire', 'education', 'corpus', 'target', 'shortfall'],
  },
  {
    intent: 'education',
    phrases: [
      'why do you', 'why should i', 'why is', 'what does that mean', 'explain',
      'how does', 'what is a', 'what is an', 'i do not understand', "i don't understand",
      'tell me about',
    ],
    words: ['why', 'explain', 'mean', 'meaning'],
  },
  {
    intent: 'overview',
    phrases: [
      'how am i doing', 'my financial position', 'where do i stand', 'summarise',
      'summarize', 'overview', 'my net worth', 'financial health', 'my situation',
    ],
    words: ['snapshot', 'position', 'health', 'score', 'worth'],
  },
];

/**
 * An imperative verb plus a figure is a command, not a question.
 *
 * "Increase my Retirement contribution to 45000" must apply the change;
 * "should I increase my retirement contribution?" must not. The difference is
 * the imperative mood and a concrete amount, so that is what this tests -
 * keyword matching alone routes both to the same place and gets one wrong.
 */
function isImperativeMutation(text: string): boolean {
  const imperative =
    /^\s*(?:please\s+)?(increase|raise|bump|reduce|lower|decrease|change|set|update|add|make it)\b/i.test(
      text,
    );
  if (!imperative) return false;
  // A hedge turns a command back into a question.
  if (/\b(should|would|could|what if|can i|is it|do you think)\b/i.test(text)) return false;
  return /\d/.test(text) || /\bgoal\b/i.test(text);
}

export function classifyIntent(message: string): { intent: Intent; confidence: number } {
  const text = ` ${message.toLowerCase().replace(/\s+/g, ' ')} `;

  if (isImperativeMutation(message)) return { intent: 'update', confidence: 0.9 };

  let best: { intent: Intent; score: number } = { intent: 'overview', score: 0 };

  for (const rule of RULES) {
    let score = 0;
    for (const phrase of rule.phrases) if (text.includes(phrase)) score += 3;
    for (const word of rule.words) if (new RegExp(`\\b${word}\\b`).test(text)) score += 1;
    if (score > best.score) best = { intent: rule.intent, score };
  }

  // Nothing matched: a short message is usually a greeting or a nudge, a long
  // one is usually a question about the user's own position.
  if (best.score === 0) {
    return { intent: message.trim().length < 25 ? 'overview' : 'actions', confidence: 0.3 };
  }
  return { intent: best.intent, confidence: Math.min(1, best.score / 6) };
}

/** Numbers the user mentioned, used to pre-fill scenario levers. */
export function extractNumbers(message: string): number[] {
  const out: number[] = [];
  // Matches 5000, 5,000, 5k, 2 lakh, 1.5 cr, 3 crore
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(k|lakh|lakhs|lac|l\b|cr|crore|crores|m\b)?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(message)) !== null) {
    const base = Number.parseFloat((match[1] ?? '').replace(/,/g, ''));
    if (!Number.isFinite(base)) continue;
    const unit = (match[2] ?? '').toLowerCase();
    let value = base;
    if (unit === 'k') value = base * 1_000;
    else if (['lakh', 'lakhs', 'lac', 'l'].includes(unit)) value = base * 100_000;
    else if (['cr', 'crore', 'crores'].includes(unit)) value = base * 10_000_000;
    else if (unit === 'm') value = base * 1_000_000;
    out.push(value);
  }
  return out;
}

/**
 * Derives scenario levers from a free-text question, so "what if I save 8000
 * more a month?" runs the right simulation without a model call.
 */
export function inferLevers(message: string, profile: UserProfile): Record<string, number> {
  const text = message.toLowerCase();
  const numbers = extractNumbers(message);
  const levers: Record<string, number> = {};

  const savingAmount = numbers.find((n) => n >= 500 && n <= profile.cashflow.monthlyNetIncome * 2);
  if (/\b(save|saving|invest|investing|put away|contribute)\b/.test(text) && savingAmount) {
    // A large figure with no "per month" wording reads as a lump sum.
    if (/\b(a month|per month|monthly|every month|\/month|pm)\b/.test(text) || savingAmount < 100_000) {
      levers.extraMonthlySavings = savingAmount;
    } else {
      levers.lumpSum = savingAmount;
    }
  }

  const lumpCandidate = numbers.find((n) => n > 100_000);
  if (/\b(bonus|windfall|inheritance|lump ?sum|maturity|sold|sale|gratuity)\b/.test(text) && lumpCandidate) {
    levers.lumpSum = lumpCandidate;
  }

  // The \b before each digit group matters: without it, greedy backtracking
  // matches the trailing digit of "15%" and reads a 5% cut.
  const spendMatch =
    /\b(\d+)\s*%[^.]{0,24}\b(?:less|cut|reduce|lower|down)\b|\b(?:less|cut|reduce|lower)\b[^.]{0,24}\b(\d+)\s*%/.exec(
      text,
    );
  if (spendMatch) {
    const pctValue = Number.parseFloat(spendMatch[1] ?? spendMatch[2] ?? '0');
    if (pctValue > 0 && pctValue < 90) levers.expenseMultiplier = 1 - pctValue / 100;
  } else if (/\b(spend less|cut (my )?(spending|expenses)|reduce (my )?(spending|expenses)|tighten)\b/.test(text)) {
    levers.expenseMultiplier = 0.9;
  }

  const retireEarly = /\b(retire|retiring)\b[^.]{0,30}\b(early|earlier|sooner)\b|\b(early|earlier)\s+retirement\b/.test(text);
  const retireLate = /\b(retire|retiring|work)\b[^.]{0,30}\b(later|longer|more years)\b/.test(text);
  const yearsMentioned = numbers.find((n) => n >= 1 && n <= 15 && Number.isInteger(n));
  // An explicit retirement age wins over a relative phrase.
  const ageMentioned = numbers.find((n) => n >= 45 && n <= 75 && Number.isInteger(n));
  if (/\bat\s*(age\s*)?\d{2}\b/.test(text) && ageMentioned) {
    levers.retirementAgeDelta = ageMentioned - profile.retirementAge;
  } else if (retireEarly) {
    levers.retirementAgeDelta = -(yearsMentioned ?? 5);
  } else if (retireLate) {
    levers.retirementAgeDelta = yearsMentioned ?? 3;
  }

  if (/\b(crash|correction|downturn|bear market|recession|market fall|drawdown|2008|covid)\b/.test(text)) {
    const shockPct = numbers.find((n) => n >= 5 && n <= 80);
    levers.marketShockPct = -((shockPct ?? 35) / 100);
    levers.shockYear = 3;
  }

  if (/\b(career break|sabbatical|time off|quit|maternity|paternity|unemploy|job loss|lose my job)\b/.test(text)) {
    const months = numbers.find((n) => n >= 1 && n <= 36 && Number.isInteger(n));
    levers.careerBreakMonths = months ?? 12;
  }

  if (/\binflation\b/.test(text)) {
    const infl = numbers.find((n) => n >= 2 && n <= 20);
    if (infl) levers.inflationPct = infl / 100;
  }

  return levers;
}

/**
 * The toolchain each intent needs. This is the plan the user sees before any
 * model call happens - every step maps to a real tool that will actually run.
 */
export function heuristicPlan(intent: Intent): AgentPlanStep[] {
  const step = (tool: string, goal: string): AgentPlanStep => ({
    id: `${tool}-${Math.random().toString(36).slice(2, 8)}`,
    tool,
    goal,
    status: 'pending',
  });

  // Every answer starts from the real position - that is what stops the agent
  // from answering a personal question with generic advice.
  const base = [step('get_financial_snapshot', 'Read the current financial position')];

  switch (intent) {
    case 'overview':
      return [
        ...base,
        step('get_next_best_actions', 'Identify what matters most right now'),
        step('synthesize', 'Summarise the position in plain language'),
      ];
    case 'goal':
      return [
        ...base,
        step('project_goal', 'Project the goal in question to its target date'),
        // Goals compete for one pool, so a gap on one is only answerable
        // alongside what funding it would cost the others.
        step('optimise_goal_funding', 'Work out how the surplus should be split across the goals'),
        step('run_monte_carlo', 'Test the projection against a range of market outcomes'),
        step('synthesize', 'Explain whether the goal is on track and what would close any gap'),
      ];
    case 'whatif':
      return [
        ...base,
        step('simulate_scenario', 'Run the scenario the user described'),
        step('search_knowledge', 'Ground the explanation in a planning principle'),
        step('synthesize', 'Compare the scenario against the current plan'),
      ];
    case 'compare':
      return [
        ...base,
        step('compare_scenarios', 'Run each option and rank them'),
        step('synthesize', 'Recommend one option and say what it costs'),
      ];
    case 'probability':
      return [
        ...base,
        step('run_monte_carlo', 'Simulate thousands of market paths'),
        step('search_knowledge', 'Explain how to read a success probability'),
        step('synthesize', 'Report the probability and the range of outcomes'),
      ];
    case 'portfolio':
      return [
        ...base,
        step('analyze_portfolio', 'Analyse allocation, risk, fees and drift'),
        step('recommend_allocation', 'Derive the target mix for this risk profile and horizon'),
        step('synthesize', 'Explain the gap and the trades that would close it'),
      ];
    case 'actions':
      return [
        ...base,
        step('get_next_best_actions', 'Rank the highest-impact actions'),
        step('optimise_goal_funding', 'Check where the money each goal needs should come from'),
        step('search_knowledge', 'Ground the top action in a principle'),
        step('synthesize', 'Present the actions in priority order with their impact'),
      ];
    case 'debt':
      return [
        ...base,
        step('plan_debt_payoff', 'Compare avalanche and snowball payoff plans'),
        step('search_knowledge', 'Check the debt-versus-investing principle'),
        step('synthesize', 'Recommend an order and quantify the interest saved'),
      ];
    case 'education':
      return [
        step('search_knowledge', 'Find the relevant planning principle'),
        ...base,
        step('synthesize', 'Explain the principle against this user’s own numbers'),
      ];
    case 'update':
      return [
        ...base,
        step('update_plan', 'Apply the change the user asked for'),
        step('synthesize', 'Confirm the change and report its effect'),
      ];
    default:
      return [...base, step('synthesize', 'Answer the question')];
  }
}

/** Concrete tool inputs for the heuristic plan, so it can run without a model. */
export function heuristicToolInput(
  tool: string,
  intent: Intent,
  message: string,
  profile: UserProfile,
): Record<string, unknown> {
  switch (tool) {
    case 'project_goal': {
      const text = message.toLowerCase();
      // Prefer a goal the user actually named; otherwise the largest must-have.
      const named = profile.goals.find((g) => text.includes(g.name.toLowerCase().split(' ')[0] ?? ''));
      const fallback =
        profile.goals.find((g) => g.kind === 'retirement') ??
        [...profile.goals].sort((a, b) => b.targetAmountToday - a.targetAmountToday)[0];
      return { goal: (named ?? fallback)?.name ?? 'Retirement' };
    }
    case 'simulate_scenario': {
      const levers = inferLevers(message, profile);
      // No recognisable lever means the user is asking loosely - show the
      // effect of the most common question instead of nothing.
      return Object.keys(levers).length ? levers : { extraMonthlySavings: 5000 };
    }
    case 'compare_scenarios': {
      const levers = inferLevers(message, profile);
      const scenarios: Record<string, unknown>[] = [];
      if (Object.keys(levers).length) scenarios.push({ ...levers, label: 'Your option' });
      scenarios.push({ extraMonthlySavings: 5000, label: 'Save 5,000 more each month' });
      scenarios.push({ expenseMultiplier: 0.9, label: 'Cut spending 10%' });
      scenarios.push({ retirementAgeDelta: 2, label: 'Work two more years' });
      return { scenarios: scenarios.slice(0, 4) };
    }
    case 'search_knowledge':
      return { query: message, limit: 3 };
    case 'plan_debt_payoff':
      return { extraMonthly: extractNumbers(message).find((n) => n >= 500 && n <= 200000) ?? 0 };
    case 'get_next_best_actions':
      return { limit: 5 };
    case 'update_plan': {
      const numbers = extractNumbers(message);
      const text = message.toLowerCase();
      const goal = profile.goals.find((g) => text.includes(g.name.toLowerCase().split(' ')[0] ?? ''));
      const amount = numbers.find((n) => n >= 100 && n <= profile.cashflow.monthlyNetIncome * 2);
      if (goal && amount !== undefined) {
        return { change: 'set_goal_contribution', goal: goal.name, monthlyContribution: amount };
      }
      return { change: 'unsupported' };
    }
    default:
      return {};
  }
}
