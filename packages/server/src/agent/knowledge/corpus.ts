/**
 * Retrieval corpus for the agent.
 *
 * Held as source rather than loose files so it bundles straight into the Lambda
 * with no asset packaging, and so a change to the advice the agent grounds on
 * shows up in code review like any other change.
 *
 * These are general financial-education notes written for this project. They are
 * deliberately principle-level and jurisdiction-light; anything tax-specific is
 * marked as illustrative.
 */

export interface KnowledgeDoc {
  id: string;
  title: string;
  tags: string[];
  content: string;
}

export const KNOWLEDGE_BASE: KnowledgeDoc[] = [
  {
    id: 'emergency-fund',
    title: 'Why the emergency fund comes first',
    tags: ['emergency', 'buffer', 'liquidity', 'protection', 'savings'],
    content: `An emergency fund is three to six months of essential expenses held in
instruments you can access within a day or two - a savings account, a sweep-in deposit
or a liquid fund. Its purpose is not returns; it is to stop a temporary income shock
from becoming a permanent capital loss.

Without a buffer, an unexpected expense forces one of two bad outcomes: selling
investments at whatever price the market happens to offer that week, or borrowing at
credit-card rates. Both convert a cashflow problem into a balance-sheet problem.

Six months is the common target for a single earner with dependents or variable income.
Three months can be enough for a dual-income household with stable salaried work and no
dependents. Count only essential expenses - rent, food, utilities, EMIs, insurance,
school fees - not discretionary spending you would cut anyway during a crisis.

The buffer should be boring by design. Money earmarked for emergencies does not belong
in equity, even if the horizon looks long, because emergencies do not wait for markets
to recover.`,
  },
  {
    id: 'debt-vs-invest',
    title: 'Paying down debt versus investing',
    tags: ['debt', 'loan', 'credit card', 'interest', 'prepay', 'invest', 'apr'],
    content: `Compare the interest rate on the debt with the expected after-tax return on
the investment. Paying down a loan gives a guaranteed return equal to its interest rate;
an investment gives an uncertain one. A guaranteed 42% from clearing a credit card beats
an expected 12% from equity, and it beats it with no volatility.

The practical ordering most planners use:
1. Pay the minimum on everything so nothing defaults.
2. Build a minimal buffer - roughly one month of expenses.
3. Clear any debt costing more than your expected portfolio return. Credit cards,
   personal loans and consumer EMIs almost always fall here.
4. Build the buffer out to three to six months.
5. Invest towards goals, while continuing scheduled payments on cheap debt.

Cheap, long-tenure debt - a home loan at single-digit rates, often with tax relief on
interest - is usually not worth prepaying aggressively while goals are underfunded. The
spread between the loan rate and expected portfolio return is where the decision lives,
and it is narrow enough that either choice is defensible.

Two non-financial factors matter and are legitimate: debt has a psychological cost, and
prepaying reduces fixed monthly commitments, which raises resilience if income is
uncertain.`,
  },
  {
    id: 'asset-allocation',
    title: 'Asset allocation and why the mix matters more than the picks',
    tags: ['allocation', 'equity', 'debt', 'diversification', 'portfolio', 'mix', 'gold'],
    content: `Asset allocation - how much sits in equity, debt, gold, real estate and cash -
explains most of the variation in a portfolio's returns and nearly all of the variation in
its risk. Security selection matters far less than the mix.

Equity carries the highest expected return and the highest volatility, and it needs a long
horizon to be reliable. Debt dampens drawdowns and funds near-term needs. Gold and REITs
diversify because they do not move in lockstep with equity - the diversification benefit
comes from low correlation, not from their standalone return.

The right mix comes from three inputs: the time until the money is needed, the ability to
absorb a loss without changing plans, and the willingness to sit through a drawdown. The
lowest of the three governs. Someone comfortable with risk but with three months of runway
cannot afford an aggressive portfolio, however they answer a questionnaire.

Volatility is not additive. Because assets are imperfectly correlated, a portfolio's risk
is lower than the weighted average of its holdings' risks. This is the entire mathematical
case for diversification, and it is why adding a low-correlation asset can reduce total
risk even when that asset is volatile on its own.`,
  },
  {
    id: 'sip-step-up',
    title: 'Systematic investing and the step-up',
    tags: ['sip', 'step-up', 'contribution', 'automate', 'increase', 'monthly'],
    content: `Investing a fixed amount on a schedule removes the two hardest decisions -
when to invest and how much - and buys more units when prices are low. Its main value is
behavioural: automated contributions survive market panics, discretionary ones do not.

The step-up is the highest-leverage change most people can make. Raising a monthly
contribution by 10% each year, in line with salary growth, roughly doubles the final
corpus over a 20-25 year horizon compared with a flat contribution. It costs nothing today
because the increase comes out of a raise that has not yet been absorbed into spending.

Time in the market dominates the amount. A contribution made in year one has decades to
compound; the same contribution in the final year has almost none. This is why starting
small and early beats waiting to start big, and why a pause early in the accumulation
phase is more expensive than an equivalent pause late.`,
  },
  {
    id: 'inflation',
    title: 'Inflation and the difference between nominal and real',
    tags: ['inflation', 'real return', 'purchasing power', 'nominal'],
    content: `A goal that costs 10 lakh today will not cost 10 lakh when you get there. At
6% inflation, costs roughly double every 12 years. Planning against today's price is the
most common single error in goal planning, and it produces a shortfall that only becomes
visible at the point when nothing can be done about it.

Not everything inflates at the headline rate. Education and healthcare have historically
run several points above general inflation; electronics have run below it. Goal-specific
inflation assumptions matter for exactly this reason.

Real return is what is left after inflation: roughly the nominal return minus the inflation
rate. A 7% deposit against 6% inflation returns about 1% in purchasing power, before tax.
Cash is not risk-free in real terms - it is a slow, certain loss.

Retirement figures should always be sanity-checked in today's money. A 6 crore corpus in 25
years sounds enormous; at 6% inflation it buys what about 1.4 crore buys today.`,
  },
  {
    id: 'monte-carlo',
    title: 'Reading a Monte Carlo simulation',
    tags: ['monte carlo', 'simulation', 'probability', 'success', 'percentile', 'risk'],
    content: `A single projection at an average return is the least likely outcome. Markets
do not deliver 11% every year; they deliver -30% and +25% in an order nobody can predict,
and the order matters.

A Monte Carlo simulation runs thousands of possible return sequences and reports the spread.
The useful outputs are the percentile bands - the median path, and the 10th and 90th
percentiles that bracket most outcomes - and the success probability, meaning the share of
simulated paths that finish at or above the target.

A success probability of 70-85% is generally considered a sound plan. Chasing 99% usually
means saving so much that you underlive the present. Below about 60%, the plan needs a
change in contribution, timeline or target rather than a hope of better returns.

What these simulations do not capture: they assume returns are drawn independently from a
well-behaved distribution. Real markets have fatter tails, trends and crashes that cluster.
They also exclude taxes and transaction costs. Treat the output as a map of the range of
outcomes, not a forecast.`,
  },
  {
    id: 'sequencing-risk',
    title: 'Sequencing risk near retirement',
    tags: ['retirement', 'sequence', 'drawdown', 'glide path', 'de-risk'],
    content: `Two retirees can earn identical average returns over thirty years and end up
in completely different places, purely because of when the bad years arrived. A large loss
in the first few years of drawdown is far more damaging than the same loss late, because
withdrawals crystallise it - you sell units at depressed prices and they never recover.

This is why portfolios should de-risk as the goal approaches, regardless of risk appetite.
A glide path shifts money from equity to debt over the final five to ten years before the
money is needed. It costs some expected return; it buys the certainty of not having the
outcome decided by the timing of one drawdown.

Keeping two to three years of planned withdrawals in cash and short-duration debt at
retirement lets the equity portion recover without being sold into weakness.`,
  },
  {
    id: 'safe-withdrawal',
    title: 'How much you need to retire',
    tags: ['retirement', 'corpus', 'withdrawal', 'swr', 'fire', 'how much'],
    content: `The corpus required is annual spending divided by a sustainable withdrawal
rate. At a 3.5% withdrawal rate, a 12 lakh annual spend needs roughly 3.4 crore; at 4% it
needs 3 crore. The withdrawal rate is the entire argument, and the range people use runs
from 3% to 4.5% depending on horizon, asset mix and how flexible spending can be.

The figure is sensitive in both directions. A 10% cut in retirement spending cuts the
required corpus by 10%. Delaying retirement by two years moves the number twice - more
years of contributions and compounding, fewer years of drawdown - which is why it is
usually the most powerful single lever available.

The spending figure should be retirement spending, not current spending. Some costs fall
(commuting, EMIs that will have been discharged, children's education) and others rise
(healthcare, travel early in retirement). Assuming current expenses continue unchanged is
a reasonable, slightly conservative default.`,
  },
  {
    id: 'risk-capacity',
    title: 'Risk capacity versus risk tolerance',
    tags: ['risk', 'tolerance', 'capacity', 'questionnaire', 'profile'],
    content: `Risk tolerance is psychological - how much volatility you can watch without
selling. Risk capacity is structural - how much loss your balance sheet and timeline can
absorb without the plan failing. They are different, they are frequently in conflict, and
the lower of the two must govern.

Capacity is driven by facts: years until the money is needed, the size of the emergency
buffer, stability of income, number of dependents, and how much of income is already
committed to fixed obligations. A long horizon raises capacity; a thin buffer or expensive
debt caps it regardless of horizon.

Tolerance is revealed by behaviour, not by self-report. The question that matters is what
someone actually did in the last drawdown, not what they predict they would do. An
investor who cannot hold a portfolio through a 30% fall will sell at the bottom, and a
theoretically optimal aggressive portfolio they abandon is worse than a conservative one
they keep.`,
  },
  {
    id: 'fees',
    title: 'Costs are the return you keep',
    tags: ['fees', 'expense ratio', 'cost', 'index', 'direct plan'],
    content: `An expense ratio is charged on assets every year, in good years and bad. The
difference between 0.2% and 1.8% looks trivial and is not: over 25 years at a 12% gross
return, the higher fee consumes roughly a third of the final corpus.

Fees compound against you exactly as returns compound for you, and unlike returns they are
certain. It is the only input to a plan that can be improved with no forecast and no risk.

Practical steps: prefer broad index funds where an active manager is not demonstrably
adding value after fees, use direct plans where you are not receiving advice you value,
and check the expense ratio of every holding at least annually. Weigh any switch against
the tax cost of realising gains - sometimes the right answer is to stop adding to the
expensive fund rather than to exit it.`,
  },
  {
    id: 'rebalancing',
    title: 'Rebalancing: keeping the plan you agreed to',
    tags: ['rebalance', 'drift', 'allocation', 'trim'],
    content: `Portfolios drift. When equity has a good run it grows into a larger share of
the total, which means the portfolio's risk rises exactly when valuations are highest.
Rebalancing sells a little of what has grown and buys what has lagged, returning the mix to
target.

Two sensible triggers: on a calendar, once or twice a year, or on a threshold, when any
asset class moves more than about five percentage points from target. Both work; doing it
constantly does not, because transaction costs and taxes accumulate.

Rebalance with new contributions wherever possible - directing fresh money to the
underweight asset achieves the same result without realising gains. It is the cheapest form
of rebalancing available and it is frequently overlooked.

Rebalancing is a risk-control tool, not a return-enhancing one. Its purpose is to stop the
portfolio's risk from quietly drifting away from what was agreed.`,
  },
  {
    id: 'goal-prioritisation',
    title: 'When goals compete for the same money',
    tags: ['goals', 'priority', 'conflict', 'tradeoff', 'education', 'competing'],
    content: `Most people have more goals than surplus. Ranking them explicitly is what
turns an impossible budget into a set of decisions.

A workable ordering: non-negotiable near-term commitments first, then long-horizon
compounding goals that cannot be funded later, then discretionary ones. Retirement is
special because it cannot be borrowed for - education can be part-funded with a loan, a
house can be deferred, retirement cannot be postponed indefinitely.

Where a must-have goal is underfunded, there are only four levers: contribute more, extend
the timeline, reduce the target, or accept more risk. The fourth is the one to reach for
last, because it does not make the goal more likely - it widens the range of outcomes in
both directions.

Naming and separating goals materially improves follow-through. Money labelled "child's
education" gets raided far less often than money in a general investment account.`,
  },
  {
    id: 'insurance',
    title: 'Insurance before investment',
    tags: ['insurance', 'term', 'health', 'cover', 'protection', 'dependents'],
    content: `Insurance protects the plan; it is not part of the plan's return. Anyone with
dependents or debt needs life cover sized so that the household can continue if the income
stops - a common rule of thumb is ten to fifteen times annual income, adjusted for
outstanding loans and existing assets.

Keep protection and investment separate. Pure term insurance costs a small fraction of a
savings-linked policy for the same cover, and the difference invested in a low-cost fund
will usually do better than the policy's internal return. Bundled products obscure both
the cost of the cover and the return on the savings.

Health cover matters at least as much. A single hospital event is one of the most common
causes of a depleted emergency fund and interrupted investing. Employer cover is a
benefit, not a plan - it ends when the job does, which is exactly when it is most needed.`,
  },
  {
    id: 'behaviour',
    title: 'The behaviour gap',
    tags: ['behaviour', 'panic', 'timing', 'discipline', 'crash', 'psychology'],
    content: `Investors reliably earn less than the funds they hold, because money arrives
after good years and leaves after bad ones. The gap between a fund's return and its
investors' return is the cost of reacting.

Three habits close most of it: automate contributions so they do not require a decision,
check the portfolio rarely - quarterly is plenty - and write down the plan including what
you will do in a 30% drawdown, while markets are calm and the answer is still rational.

Market timing does not work reliably, and the cost of being out is asymmetric: a small
number of days account for a large share of long-run returns, and they cluster near the
worst periods, precisely when a nervous investor is most likely to be in cash.

A plan you will actually follow through a crash beats an optimal plan you will abandon.
That is a real constraint, not a failure of discipline, and a good plan is built around it.`,
  },
];
