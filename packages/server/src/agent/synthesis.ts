import {
  formatCompact,
  type DebtPayoffPlan,
  type FinancialSnapshot,
  type GoalProjection,
  type MonteCarloResult,
  type NextBestAction,
  type PortfolioAnalysis,
  type ScenarioResult,
  type UserProfile,
} from '@wealth/shared';
import { retrieve } from './knowledge/retriever.js';
import type { Intent } from './intent.js';
import type { ToolResult } from './tools.js';

/**
 * Template synthesiser for the no-credentials path.
 *
 * Every sentence here is built from a tool result, so the output passes the same
 * grounding verifier the model's answers go through. It reads like a briefing
 * rather than a conversation - the trade-off being that it costs nothing, never
 * rate-limits, and cannot hallucinate a figure.
 */

export interface SynthesisInput {
  intent: Intent;
  message: string;
  profile: UserProfile;
  runs: { tool: string; result: ToolResult }[];
  degraded: boolean;
}

function find<T>(runs: SynthesisInput['runs'], tool: string): T | undefined {
  const data = runs.find((r) => r.tool === tool)?.result.data;
  // A tool that refused its input returns `{ error }`, not its usual shape.
  // Templating over that printed "undefined is not on track ... ₹NaN", or threw
  // and lost the whole answer - the tool's own summary says it better.
  if (data && typeof data === 'object' && 'error' in data) return undefined;
  return data as T | undefined;
}

/** The summary of a tool that ran but could not produce a result. */
function failure(runs: SynthesisInput['runs'], tool: string): string | undefined {
  const run = runs.find((r) => r.tool === tool);
  const data = run?.result.data;
  return data && typeof data === 'object' && 'error' in data ? run?.result.summary : undefined;
}

export function composeDeterministicAnswer(input: SynthesisInput): string {
  const { profile } = input;
  const money = (v: number) => formatCompact(v, profile.currency);
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
  const paragraphs: string[] = [];

  const snapshot = find<FinancialSnapshot>(input.runs, 'get_financial_snapshot');

  switch (input.intent) {
    /*
     * A greeting gets a greeting: one orienting line, then what to ask.
     *
     * The temptation is to answer with everything, since the snapshot is
     * already in hand - which is what this used to do, meeting "hello" with a
     * wellness score, a net worth, a weakest pillar and a recommendation. The
     * headline number is worth offering unprompted because it is the one thing
     * that says whether to worry. The rest is an answer to a question nobody
     * asked, and it hides the thing a new user actually needs: knowing what
     * this can be asked for.
     */
    case 'greeting': {
      const name = profile.displayName.split(' ')[0];
      if (!snapshot) {
        paragraphs.push(
          `Hello${name ? ` ${name}` : ''} - I can read your position, project any goal, run what-if scenarios against thousands of simulated markets and explain the reasoning behind any recommendation. What would you like to look at?`,
        );
        break;
      }
      paragraphs.push(
        `Hello${name ? ` ${name}` : ''}. Your financial wellness score is currently ${snapshot.wellness.total}/100, grade ${snapshot.wellness.grade}.`,
      );
      paragraphs.push(
        'Ask me anything about your money and I will work it out from your actual numbers rather than from rules of thumb. For example:',
      );
      paragraphs.push(
        [
          '- "Am I on track to retire?"',
          '- "Which debt should I clear first?"',
          '- "What happens if I save 5,000 more each month?"',
          '- "What should I do next?"',
        ].join('\n'),
      );
      break;
    }
    case 'overview': {
      if (!snapshot) break;
      const onTrack = snapshot.goalProjections.filter((g) => g.onTrack).length;
      const weakest = [...snapshot.wellness.pillars].sort((a, b) => a.score - b.score)[0];
      // A negative surplus is not "less money left over" - it means the
      // commitments already exceed the income, which needs saying plainly.
      const surplusClause =
        snapshot.cashflow.monthlySurplus >= 0
          ? `leaving ${money(snapshot.cashflow.monthlySurplus)} a month uncommitted`
          : `but your goal contributions and EMIs currently exceed your income by ${money(Math.abs(snapshot.cashflow.monthlySurplus))} a month, so something has to give`;
      paragraphs.push(
        `Your financial wellness score is ${snapshot.wellness.total}/100 (grade ${snapshot.wellness.grade}). Net worth is ${money(snapshot.netWorth.netWorth)} - ${money(snapshot.netWorth.assets)} of assets against ${money(snapshot.netWorth.liabilities)} of debt - and you are saving ${pct(snapshot.cashflow.savingsRatePct)} of your income, ${surplusClause}.`,
      );
      paragraphs.push(
        `${onTrack} of your ${snapshot.goalProjections.length} goals are fully funded on current behaviour, and retirement is ${pct(snapshot.retirement.readinessRatio)} funded against the ${money(snapshot.retirement.corpusRequired)} you would need. ${weakest ? `Your weakest area is ${weakest.name} at ${weakest.score}/100: ${weakest.summary}` : ''}`,
      );
      const actions = find<NextBestAction[]>(input.runs, 'get_next_best_actions');
      const top = actions?.[0];
      if (top) {
        paragraphs.push(
          `The highest-impact thing you can do next is: ${top.title}. ${top.why} Expected effect - ${top.impact.metric.toLowerCase()}: ${formatImpact(top, profile)}.`,
        );
      }
      break;
    }

    case 'goal': {
      const projection = find<GoalProjection>(input.runs, 'project_goal');
      if (!projection) {
        const reason = failure(input.runs, 'project_goal');
        if (reason) paragraphs.push(reason);
        break;
      }
      if (projection.onTrack) {
        paragraphs.push(
          `"${projection.goalName}" is on track. It needs ${money(projection.inflatedTarget)} in ${projection.yearsToGoal.toFixed(1)} years once inflation is applied, and your current contribution projects to ${money(projection.projectedCorpus)} - a surplus of ${money(projection.surplus)}.`,
        );
      } else {
        paragraphs.push(
          `"${projection.goalName}" is not on track. It will cost ${money(projection.inflatedTarget)} by the time you get there, and your current plan projects ${money(projection.projectedCorpus)} - only ${pct(projection.fundedRatio)} funded, a shortfall of ${money(Math.abs(projection.surplus))}.`,
        );
        paragraphs.push(
          `Closing it takes ${money(projection.requiredMonthly)} a month, an increase of ${money(projection.monthlyGap)} on what you contribute now. ${
            projection.requiredReturnPct === null
              ? 'No realistic return would close this gap without a larger contribution.'
              : `The alternative would be earning ${(projection.requiredReturnPct * 100).toFixed(1)}% a year instead of the ${(projection.assumedReturnPct * 100).toFixed(1)}% this projection assumes - and a return is not something you can choose.`
          }`,
        );
      }
      const mc = find<MonteCarloResult>(input.runs, 'run_monte_carlo');
      if (mc) {
        /*
         * `run_monte_carlo` simulates the retirement plan. Placed straight after
         * a paragraph about, say, the home goal, "X% reach the target" read as
         * that goal's odds. It is labelled as retirement unless the goal in
         * question is the retirement goal.
         */
        const goal = profile.goals.find((g) => g.id === projection.goalId);
        const aboutRetirement = goal?.kind === 'retirement';
        paragraphs.push(
          `${aboutRetirement ? 'Across' : 'For your retirement plan as a whole, across'} ${mc.paths.toLocaleString('en-US')} simulated market paths, ${pct(mc.successProbability)} reach the ${money(mc.target)} ${aboutRetirement ? 'target' : 'retirement target'}. The middle outcome is ${money(mc.median)}, with a range from ${money(mc.p10)} at the 10th percentile to ${money(mc.p90)} at the 90th - all in today's money.`,
        );
      }
      break;
    }

    case 'whatif': {
      const scenario = find<ScenarioResult>(input.runs, 'simulate_scenario');
      if (!scenario) {
        const reason = failure(input.runs, 'simulate_scenario');
        if (reason) paragraphs.push(reason);
        break;
      }
      paragraphs.push(scenario.explanation);
      const movedGoals = scenario.goalProjections.filter((g) => g.onTrack).length;
      const surplus = scenario.snapshot.monthlySurplus;
      paragraphs.push(
        `Under this scenario ${movedGoals} of ${scenario.goalProjections.length} goals are fully funded and your wellness score moves to ${scenario.snapshot.wellnessScore}/100 (${scenario.deltaVsBaseline.wellnessScore >= 0 ? '+' : ''}${scenario.deltaVsBaseline.wellnessScore}). ${
          surplus >= 0
            ? `That leaves ${money(surplus)} a month still uncommitted.`
            : `Note that it would leave your commitments ${money(Math.abs(surplus))} a month above your income, so it only works alongside a spending cut or a longer timeline.`
        }`,
      );
      break;
    }

    case 'compare': {
      const comparison = find<{ results: ScenarioResult[] }>(input.runs, 'compare_scenarios');
      const results = comparison?.results ?? [];
      const winner = results[0];
      if (!winner) break;
      paragraphs.push(
        `Of the options tested, "${winner.label}" comes out ahead: it projects ${money(winner.snapshot.netWorthAtRetirement)} at retirement, ${money(Math.abs(winner.deltaVsBaseline.netWorthAtRetirement))} ${winner.deltaVsBaseline.netWorthAtRetirement >= 0 ? 'more' : 'less'} than your current plan, with ${pct(winner.monteCarlo.successProbability)} of simulated paths reaching the target.`,
      );
      if (results.length > 1) {
        paragraphs.push(
          `The full ranking: ${results.map((r, i) => `${i + 1}) ${r.label} - ${money(r.snapshot.netWorthAtRetirement)}`).join(', ')}. The gap between the best and worst option is ${money(Math.abs((results[0]?.snapshot.netWorthAtRetirement ?? 0) - (results[results.length - 1]?.snapshot.netWorthAtRetirement ?? 0)))}, which is the real size of this decision.`,
        );
      }
      break;
    }

    case 'probability': {
      const mc = find<MonteCarloResult>(input.runs, 'run_monte_carlo');
      if (!mc) break;
      const verdict =
        mc.successProbability >= 0.85
          ? 'That is a comfortable plan - arguably you could spend a little more today.'
          : mc.successProbability >= 0.7
            ? 'That is a sound plan. Most planners treat 70-85% as the target range.'
            : mc.successProbability >= 0.5
              ? 'That is below the 70% most planners aim for, so the plan needs a change in contribution, timeline or target.'
              : 'That is a plan that more likely than not falls short, and better returns are not something you can choose.';
      paragraphs.push(
        `${pct(mc.successProbability)} of ${mc.paths.toLocaleString('en-US')} simulated market paths reach your ${money(mc.target)} target. ${verdict}`,
      );
      paragraphs.push(
        `The spread matters more than the average: the median path ends at ${money(mc.median)}, but a bad sequence of returns lands you near ${money(mc.p10)} and a good one near ${money(mc.p90)}. That range is the honest answer - a single projected number would hide it.`,
      );
      break;
    }

    case 'portfolio': {
      const analysis =
        find<{ portfolio: PortfolioAnalysis; recommended: Record<string, number> }>(
          input.runs,
          'analyze_portfolio',
        ) ?? (snapshot ? { portfolio: snapshot.portfolio, recommended: snapshot.recommendedAllocation } : undefined);
      if (!analysis) break;
      const p = analysis.portfolio;
      paragraphs.push(
        `Your ${money(p.totalValue)} portfolio has an expected return of ${(p.expectedReturnPct * 100).toFixed(1)}% a year with ${(p.volatilityPct * 100).toFixed(1)}% volatility - meaning a typical year lands within about ${(p.volatilityPct * 100).toFixed(0)} percentage points either side of that. Its diversification score is ${p.diversificationScore}/100 across ${p.effectivePositions} effective positions.`,
      );
      if (p.totalDriftPct > 5) {
        paragraphs.push(
          `${p.totalDriftPct}% of your portfolio sits in the wrong asset class. ${p.rebalanceTrades.slice(0, 3).map((t) => `${t.action} ${money(t.amount)} of ${t.assetClass.replace(/_/g, ' ')}`).join(', ')} would bring it back. Doing it with new contributions rather than sales avoids realising gains.`,
        );
      } else {
        paragraphs.push(`Only ${p.totalDriftPct}% of your portfolio is out of position, so no rebalancing is needed right now.`);
      }
      if (p.largestSingleSecurity && p.largestSingleSecurity.weight > 0.15) {
        paragraphs.push(
          `One thing to flag: ${p.largestSingleSecurity.name} is ${pct(p.largestSingleSecurity.weight)} of your invested assets. That is company-specific risk you are not paid to take.`,
        );
      }
      if (p.blendedExpenseRatioPct > 0.006) {
        paragraphs.push(
          `Your blended fund cost is ${(p.blendedExpenseRatioPct * 100).toFixed(2)}% a year. Fees are the only input to your returns that is certain, and lower-cost index equivalents exist for most of what you hold.`,
        );
      }
      break;
    }

    case 'actions': {
      const actions = find<NextBestAction[]>(input.runs, 'get_next_best_actions') ?? [];
      if (actions.length === 0) break;
      paragraphs.push(
        `Ranked by impact against effort and urgency, here is where to start${snapshot ? ` from your ${snapshot.wellness.total}/100 wellness score` : ''}:`,
      );
      paragraphs.push(
        actions
          .slice(0, 4)
          .map(
            (a, i) =>
              `${i + 1}. **${a.title}** - ${a.why} Effect: ${a.impact.metric.toLowerCase()} ${formatImpact(a, profile)}. Effort: ${a.effort}.`,
          )
          .join('\n\n'),
      );
      const top = actions[0];
      if (top?.steps.length) {
        paragraphs.push(`To do the first one: ${top.steps.slice(0, 3).join(' ')}`);
      }
      break;
    }

    case 'debt': {
      const plan = find<{ avalanche?: DebtPayoffPlan; snowball: DebtPayoffPlan; interestSaved: number }>(
        input.runs,
        'plan_debt_payoff',
      );
      // A debt-free profile gets `{ debts: [] }` back, not a plan. Reading
      // `plan.avalanche.unpayable` off that threw, and the user got "I could not
      // complete that request" for asking about a loan they do not have.
      if (!plan?.avalanche) {
        paragraphs.push('You have no liabilities recorded, so there is nothing to pay off.');
        break;
      }
      // An unpayable debt leads, because a payoff comparison is moot while a
      // balance is still growing every month.
      for (const u of plan.avalanche.unpayable) {
        paragraphs.push(
          `Before comparing strategies: **${u.name}** at ${(u.interestRatePct * 100).toFixed(1)}% never clears at your current payment. It is about ${money(u.monthlyShortfall)} a month short of merely covering its own interest, so the balance grows regardless of what else you do. Raising that payment comes before every other step in this plan.`,
        );
      }
      // The comparison follows the numbers: avalanche is usually cheaper, but a
      // debt that never clears drops out of one order's total, and with a single
      // debt the two orders are the same plan.
      const verdict =
        plan.interestSaved > 0
          ? `so the avalanche saves ${money(plan.interestSaved)}`
          : plan.interestSaved < 0
            ? `so here the snowball costs ${money(-plan.interestSaved)} less`
            : 'so both orders cost the same';
      paragraphs.push(
        `Paying highest-interest-first (the avalanche) clears ${plan.avalanche.order.length} of your ${profile.liabilities.length} debts in ${plan.avalanche.monthsToDebtFree} months with ${money(plan.avalanche.totalInterestPaid)} of total interest. Smallest-balance-first (the snowball) takes ${plan.snowball.monthsToDebtFree} months and costs ${money(plan.snowball.totalInterestPaid)} - ${verdict}.`,
      );
      if (plan.avalanche.order.length > 0) {
        paragraphs.push(
          `The order to clear them: ${plan.avalanche.order.map((o) => `${o.name} (month ${o.payoffMonth})`).join(', then ')}.`,
        );
      }
      const expensive = profile.liabilities.filter(
        (l) => l.interestRatePct > (snapshot?.portfolio.expectedReturnPct ?? 0.11),
      );
      if (expensive.length > 0) {
        paragraphs.push(
          `${expensive.map((l) => `${l.name} at ${(l.interestRatePct * 100).toFixed(1)}%`).join(' and ')} cost more than your portfolio is expected to earn. Clearing them is a guaranteed return at that rate, which no investment can promise - so they come before any new investing.`,
        );
      }
      break;
    }

    case 'education': {
      const hits = retrieve(input.message, 2);
      const primary = hits[0];
      if (primary) {
        paragraphs.push(`**${primary.title}.** ${primary.snippet}`);
      }
      if (snapshot) {
        paragraphs.push(
          `Applied to your position: you have ${snapshot.cashflow.emergencyFundMonths} months of emergency cover, a ${pct(snapshot.cashflow.savingsRatePct)} savings rate, a ${snapshot.risk.bucket} risk profile, and retirement is ${pct(snapshot.retirement.readinessRatio)} funded. ${snapshot.risk.drivers[0] ?? ''}`,
        );
      }
      if (hits[1]) paragraphs.push(`Related: **${hits[1].title}.** ${hits[1].snippet}`);
      break;
    }

    case 'update': {
      const update = find<{ snapshot?: FinancialSnapshot }>(input.runs, 'update_plan');
      const summary = input.runs.find((r) => r.tool === 'update_plan')?.result.summary;
      paragraphs.push(summary ?? 'No change was applied.');
      if (update?.snapshot) {
        const after = update.snapshot;
        paragraphs.push(
          `Your plan now scores ${after.wellness.total}/100 with ${after.goalProjections.filter((g) => g.onTrack).length} of ${after.goalProjections.length} goals fully funded and retirement ${pct(after.retirement.readinessRatio)} funded.`,
        );
      }
      break;
    }
  }

  if (paragraphs.length === 0) {
    // Nothing matched - fall back to the position summary rather than an apology.
    if (snapshot) {
      paragraphs.push(
        `Here is where you stand: wellness ${snapshot.wellness.total}/100, net worth ${money(snapshot.netWorth.netWorth)}, ${money(snapshot.cashflow.monthlySurplus)} of monthly surplus, and retirement ${pct(snapshot.retirement.readinessRatio)} funded. ${snapshot.actions[0] ? `The highest-priority action is: ${snapshot.actions[0].title}.` : ''}`,
      );
      paragraphs.push(
        'Ask me about a specific goal, run a what-if scenario, or ask what to do next and I can go deeper.',
      );
    } else {
      paragraphs.push(
        'I could not read your financial position. Complete the onboarding or load a sample profile and ask again.',
      );
    }
  }

  if (input.degraded) {
    paragraphs.push(
      '_The language model was unavailable for this answer, so this was generated by the platform’s deterministic engine. The numbers come from the same financial engine and are unaffected._',
    );
  }

  return paragraphs.filter(Boolean).join('\n\n');
}

function formatImpact(action: NextBestAction, profile: UserProfile): string {
  const { value, unit } = action.impact;
  if (unit === 'currency') return formatCompact(value, profile.currency);
  if (unit === 'percent') return `${value}%`;
  return `${value} ${unit}`;
}
