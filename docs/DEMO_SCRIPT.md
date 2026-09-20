# Demo Script

A six-minute walkthrough with a narrative: *this user is in trouble, here is exactly why, and here is the one thing that fixes it.*

**Setup:** `npm run dev`, browser at <http://localhost:5173>, dark theme, a second tab on the repository for the code moments. If you have credentials, export `ANTHROPIC_API_KEY` first so the assistant answers in Claude's prose — but the script works either way, and the deterministic engine is itself worth 15 seconds of the demo.

Timings are cumulative.

---

## 0:00 — The problem, in one sentence

> "Three questions nobody can answer about their own money: where do I stand, what happens if I change something, and what should I do next. Every tool shows balances. Almost none of them reason, and none of them show their work. That's what we built."

**Do not** open with the architecture. Open with the user.

---

## 0:20 — Pick a persona

Land on onboarding. Three sample profiles, each stating the planning problem it illustrates.

> "Three synthetic personas, each broken in a different way. I'll take Meera — 38, two children, good income, and three must-have goals bidding for the same money."

Click **Meera** → **Open this sample profile**.

> "Or enter your own numbers — it's a five-step wizard, and your wellness score updates as you type. I'll skip it for time."

---

## 0:40 — The dashboard: the diagnosis

> "Wellness score 61 out of 100, grade C. Not a black box — five weighted pillars, each with its own arithmetic beside it. Her weakest is Goals at 18 out of 100."

Point at the pillar meters, then the KPI row.

> "Net worth ₹44 L. But look at the surplus: **negative ₹31,000 a month.** Her goal contributions and EMIs already exceed her income. She isn't under-saving — she's over-committed, and nothing on a normal dashboard would tell her that."

Scroll to **Goal funding**.

> "Zero of three goals funded. And this bar is the important one — grey is what she'll need *at the goal date*, after inflation. Her education goal inflates at 10%, not the headline 6%, because education always has. Planning against today's price is how people discover a shortfall at the exact moment nothing can be done."

---

## 1:30 — Next Best Actions: the prescription

Click **Next Best Actions**.

> "Thirteen rule checks, ranked by impact against effort — but ordered by the planning waterfall, not by raw impact. Protection, then expensive debt, then goals, then optimisation."

Expand the top action.

> "Every action has four things: why it applies to *her*, what it's worth in rupees, the steps, and — this one matters — the assumptions it made. Inflation rate, assumed return, the contribution it started from. Nothing is asserted without its working."

Open the assumptions disclosure. Point at the source tags.

> "Colour-coded by provenance: her input, our house view, a model default, or derived. If she disagrees with an assumption, she can see exactly which number to change."

Click **Apply to my plan** on a goal action.

> "That's not a simulation — it edited her plan. Watch the list re-rank itself. Advice you have to re-enter somewhere else is advice nobody takes."

---

## 2:30 — The Scenario Lab: the centrepiece

Click **Scenario Lab**. Pause on the presets.

> "The questions people actually arrive with."

Click **Save 5,000 more each month**, then **drag the slider slowly**.

> "Every number is recomputing as I drag — the projection, the retirement corpus, the fan chart, a two-thousand-path Monte Carlo. No spinner, no round trip."

**The code moment — 15 seconds, do not skip it:**

> "That's because the financial engine is one shared TypeScript package imported by both the browser and the Lambda. Same functions, same arithmetic. The number this slider shows and the number the AI quotes are produced by identical code — they can't drift, because there's nothing to drift from."

Point at the fan chart.

> "And this is the honest part. The middle line is the median, the bands are the 10th to 90th percentile. A single projected line is the *least likely* outcome of all."

Point at the funded percentage next to the success probability.

> "She's 78% funded on the average path — but only 20% of simulated paths actually reach the target. That gap is precisely why a Monte Carlo exists. An average hides it."

Drag **Market crash** to −35%, set the year to 3.

> "A 2008-style drawdown three years out. The corpus falls, but not by 35% — because contributions keep flowing through it, and that's what makes recovery possible. Most tools can't model that."

Click **Pin for comparison**, change to **Retire 5 years earlier**, pin again.

> "Now compare them on one axis, against the line marking her current plan. This is the decision, sized."

---

## 4:00 — The AI Assistant: the agent

Click **AI Assistant**. Type: **"What if I take a 12-month career break and then save 20,000 more a month?"**

**Say nothing for a moment. Let the trace fill.**

> "Watch the right panel. It classified the intent, published a plan, and is now calling tools one at a time — with timings."

As it completes:

> "Four tools. It read her real position first, ran the scenario through the engine, pulled the relevant planning principle from the knowledge base, then wrote the answer."

Point at the grounding check.

> "And this is the part I'd want a judge to look at. After it writes the answer, we extract every financial figure from the prose and match it back against what the tools actually returned. Seven of seven grounded, each with the source named."

> "Because the model never calculates. Twelve tools wrap the engine; the system prompt says arithmetic in its head is a bug. The recommendations come from a deterministic rule engine, so two users with the same balance sheet get the same list. The model's job is to explain which one matters for *her*, and why. That's what makes this auditable instead of just fluent."

Optional, if you have 20 seconds:

> "And with no API key at all, every one of those steps still runs — it plans, calls the same tools, grounds every number, and answers from templates. That's not a stub, it's the fallback behind every model failure. Rate limit, refusal, outage: the product degrades to less fluent prose, never to an error page."

---

## 5:00 — Assumptions: the trust argument

Click **Assumptions**.

> "The brief asked for assumptions to be visible. We made them editable."

Drag the **safe withdrawal rate** from 3.5% to 3%.

> "Her required corpus just jumped by a sixth. One assumption. That sensitivity is exactly why it's a slider and not a footnote — it shows that 'you'll need ₹15 crore' is a consequence of assumptions, not a fact about the future."

Scroll to the bottom.

> "And this is the section most tools don't ship: what we deliberately *don't* model. No taxes. No transaction costs. Thin tails — real markets crash harder than a log-normal implies. An unstated omission is a misleading result."

---

## 5:40 — Close

> "React on CloudFront, Express on Lambda, DynamoDB, Claude via Bedrock — no API key anywhere in the deployed system, because the Lambda role carries the permission. One CDK deploy. CI runs 117 tests plus a smoke test against the built artefact, because a clean typecheck once gave us a bundle that died on startup."

> "The measurable outcome: a user goes from a set of balances to a ranked, quantified, auditable plan in under two minutes — and can see the arithmetic behind every number in it."

---

## Recording notes

- **1920×1080, 100% browser zoom.** The layout is responsive but the chart labels are sized for this.
- **Dark theme.** Higher contrast on a projector and better on video compression.
- **Slow the slider drags.** The live recomputation is the thing worth seeing; a fast drag reads as a page refresh.
- **Do not narrate over the agent trace.** Let two or three seconds of silence pass while the tool calls land. It is more convincing than describing it.
- **Have the second tab ready** on `packages/shared/src/finance/montecarlo.ts` for the variance-drag comment if a judge asks about simulation quality.

## Backup plan if something fails

| If | Then |
|---|---|
| The agent is slow or unavailable | Unset `ANTHROPIC_API_KEY` and restart. The deterministic engine answers instantly, and it becomes a feature to talk about. |
| A chart looks wrong | Open the **View as table** disclosure under it — every chart has one. |
| The whole app fails | `npm test` — 117 passing tests in about fifteen seconds is a credible fallback demo of the engine. |

## The 60-second version

If the slot collapses: dashboard (negative surplus, zero of three goals funded) → Scenario Lab (drag one slider, point at the fan chart) → Assistant (one question, point at the grounding check). Skip everything else.
