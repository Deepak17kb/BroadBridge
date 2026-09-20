# Architecture

AI Wealth Navigator — an agentic financial wellness platform.

This document records what was built, and more importantly *why each choice was made and what it cost*. Decisions without trade-offs are usually decisions nobody examined.

---

## 1. The problem

People cannot answer three questions about their own money:

1. **Where do I actually stand?** Balances are visible; whether they add up to a plan is not.
2. **What happens if I change something?** Save more, retire earlier, survive a crash — normally unanswerable without a spreadsheet.
3. **What should I do next?** Generic advice ("build an emergency fund") is not a decision. "Move ₹1.99 L, which takes you from 4.5 to 6 months of cover, and do it before the extra SIP" is.

Existing tools show charts. They rarely reason, and when they do, they cannot show their work.

---

## 2. System overview

```
 ┌──────────────────────── CloudFront (single origin) ────────────────────────┐
 │                                                                            │
 │   /  ·  /assets/*                          /api/*                          │
 │        │                                      │                            │
 │        ▼                                      ▼                            │
 │   S3 bucket (private, OAC)            API Gateway HTTP API                 │
 │   React 18 + Vite bundle                      │                            │
 └───────────────────────────────────────────────┼────────────────────────────┘
                                                 ▼
                                    ┌────────────────────────┐
                                    │  Lambda (Node 22, ARM) │
                                    │  Express + agent       │
                                    └───┬────────────────┬───┘
                                        │                │
                              ┌─────────▼──────┐  ┌──────▼──────────┐
                              │  DynamoDB      │  │  Amazon Bedrock │
                              │  single table  │  │  Claude Opus 5  │
                              └────────────────┘  └─────────────────┘
```

### Why one CloudFront distribution for both app and API

The browser sees a single origin. That buys three things:

- No CORS preflight on any call, including the SSE stream.
- No API URL baked into the bundle at build time, so the same artefact deploys to any stage.
- The streaming endpoint is not a cross-origin `EventSource`, which avoids a class of proxy and cookie problems entirely.

The cost is one extra cache behaviour and the requirement to strip the `Host` header on the API origin (API Gateway rejects a forwarded host that is not its own). Worth it.

### Why Lambda rather than Fargate

The workload is request-shaped and bursty. A 2,000-path, 20-year Monte Carlo is roughly half a million floating-point operations — single-digit milliseconds. The deployment artefact is one 230 KB bundled file. An always-warm container would cost money to sit idle and buy nothing.

The cost is cold starts. Mitigated by ARM64 (cheaper per ms), a single-file bundle (nothing to resolve at boot), lazily constructing the Bedrock client, and a 60-second timeout so a multi-step agent run has room.

### Why DynamoDB, single table

The access patterns are known and narrow: get a profile by id, list a profile's sessions, get a session. Both are a single query against one partition:

```
pk = PROFILE#<id>   sk = meta            → the profile document
pk = PROFILE#<id>   sk = SESSION#<id>    → a chat session
```

Sessions live under their profile's partition, so listing a user's conversations is one query rather than a scan, and deleting a profile takes its history with it. A `byType` GSI serves profile listing and session-by-id lookup without ever scanning.

A relational database would model this fine and add a VPC, a connection pool and an idle instance. It would be the right call the moment cross-user analytics appear; today it would be cost with no benefit.

---

## 3. The load-bearing decision: one engine, two runtimes

`@wealth/shared` holds every financial calculation in the system. Both the browser and the Lambda import it **as TypeScript source**:

- Vite aliases `@wealth/shared` to `../shared/src/index.ts` and compiles it into the client bundle.
- tsup bundles the same source into the Lambda artefact (`noExternal: [/^@wealth\//]` — see §9 for why that was a bug first).

**What this buys.** Dragging a Scenario Lab slider recomputes the full model — projections, retirement sizing, wellness score, Monte Carlo — locally, in a few milliseconds. No debounce-and-wait, no loading state, no round trip. The agent's tools then call the identical functions server-side, so the number a slider showed and the number the AI quotes are produced by the same code path. They cannot drift, because there is nothing to drift from.

**What it costs.** The client bundle carries the engine (~20 KB of the 192 KB app chunk — the engine is arithmetic, not dependencies). The two packages are coupled: a breaking change to the engine breaks both at once. Given the alternative is two implementations of compound interest that silently diverge, that coupling is a feature.

**The alternative considered.** Server-only computation with an API call per slider change. Rejected: a what-if tool where every adjustment costs a network round trip is a form, not a model.

---

## 4. The finance engine

Pure functions over plain data. No classes, no I/O, no framework — which is why it is straightforward to test exhaustively.

| Module | Responsibility |
|---|---|
| `finance/math.ts` | Rate conversion, annuity factors with step-up, exact solvers, seeded RNG, percentiles, shock-aware accumulation |
| `finance/portfolio.ts` | Covariance-based volatility, glide path, drift, rebalancing, concentration |
| `finance/risk.ts` | Two-axis risk profiling with knock-out constraints |
| `finance/goals.ts` | Goal projection with per-goal inflation and return |
| `finance/montecarlo.ts` | Geometric Brownian Motion with variance-drag correction |
| `finance/cashflow.ts` | Cashflow, net worth, retirement sizing with drawdown, debt payoff, wellness score |
| `finance/actions.ts` | Fifteen-rule recommendation engine |
| `finance/engine.ts` | Composition: `buildSnapshot` and `runScenario` |

### Four choices that matter

**Geometric rate conversion.** Monthly rate is `(1+r)^(1/12) − 1`, never `r/12`. The naive form overstates a 12% portfolio by about 0.6% a year, which compounds into a materially wrong 25-year figure. A test asserts `(1+i)^12` returns exactly 1.12.

**Variance drag in the Monte Carlo.** Monthly log-returns are drawn as `N(ln(1+μ)/12 − σ²/24, σ/√12)`. Omitting the `−σ²/2` term is the most common bug in retirement simulators: it silently inflates the median outcome by several percent a year. A test asserts the simulated median tracks the closed-form projection.

**Exact solvers, not search.** Future value is linear in the contribution, so the required contribution is computed directly rather than by iterating. The required *return* is genuinely non-linear, so that one bisects — and returns `null` when no return in a sane range would close the gap, instead of reporting an absurd number.

**Protection is sized on two rules, not one.** Health cover is `max(annual income × multiple, floor for age band) + per-dependent loading`. Income alone under-insures a young earner, whose first serious admission costs what it costs regardless of salary; a floor alone under-insures a high earner, whose household loses far more when treatment interrupts it. Taking the higher of the two is the whole point. All five constants live in `assumptions.ts` and are editable in the ledger, and the rule reports the knock-on nobody prices in — an uncovered event is paid out of savings, so while the gap is open the emergency-fund target is effectively `target + gap`. Life cover ranks above health cover inside the protection block, bounded so it always does.

**Everything seeded.** `mulberry32` plus Box-Muller, with the seed carried in the result. The same inputs always produce the same fan chart, so a recommendation citing a success probability can be re-derived exactly. Without this, "82% chance" is unauditable.

### Risk profiling: two axes and hard caps

Tolerance (behavioural willingness) and capacity (structural ability) are scored separately, and the recommendation follows `min(tolerance, capacity)`.

Capacity is a weighted blend of horizon, buffer, dependents, income stability and debt load — **then subjected to knock-out caps**:

| Condition | Capacity capped at |
|---|---|
| Under 1 month of expenses in reserve | 30 |
| Under 3 months | 55 |
| High-interest debt exceeding a month's income | 50 |
| EMIs above half of income | 40 |

This was added after the first implementation scored the early-career persona at 72/100 capacity — a 34-year horizon at 30% weight was scoring away six weeks of savings and a 42% credit-card balance. Real risk questionnaires use knock-out constraints for exactly this reason. Every cap that fires is surfaced verbatim in the UI as a reason.

### Concentration measured on securities only

The first version scored the mid-career persona at 95/100 diversification while a third of her money sat in one provident fund, and 97/100 for the pre-retirement persona holding 31% in a single stock. Two bugs:

1. **Scoring breadth off `1 − HHI`** is far too generous — four lopsided positions scored 94.
2. **Treating every holding as a concentration risk.** A 39% provident-fund position is not a concentration problem; a 31% single-stock position is.

Holdings now carry `instrumentKind: 'fund' | 'security' | 'deposit'`, and the score combines asset-class spread (40%), *effective* position count `1/HHI` (30%) and largest-single-security weight (30%). The same fix stopped the action engine generating "trim your provident fund" advice.

---

## 5. The agent

```
  ┌──────────┐    ┌───────────────┐    ┌─────────────┐    ┌──────────┐
  │   PLAN   │───►│      ACT      │───►│ SYNTHESIZE  │───►│  VERIFY  │
  │ classify │    │  tool loop    │    │ stream text │    │ grounding│
  └────┬─────┘    └───────┬───────┘    └──────┬──────┘    └────┬─────┘
       │                  │                   │                │
       └──────────────────┴───────────────────┴────────────────┘
                                    │
                            SSE events to the client
```

### The division of labour

**The model narrates and prioritises. It never calculates.** Twelve tools wrap the engine; the system prompt states that arithmetic done in the model's head is a bug. Recommendations come from the deterministic rule engine, so two users with the same balance sheet get the same list in the same order — and the model's job is to explain which one matters for *this* person and why.

This is not caution for its own sake. It makes the advice reproducible, testable and auditable, and it removes the main route by which a hallucinated figure could reach a user.

### Streaming the trace

Every phase emits SSE events: `plan`, `tool_call`, `tool_result`, `retrieval`, `token`, `verification`, `final`. The client renders them as a live timeline with per-tool timings.

SSE over WebSockets: the traffic is one-directional, it passes through API Gateway and CloudFront without a second protocol, and `EventSource` reconnects on its own. The cost is that the message rides in a query string (hence the length cap) and there is no client-to-server channel mid-run — neither of which this feature needs.

### The grounding verifier

After synthesis, every financial figure in the prose is extracted and matched against the union of numbers the tools returned. Unmatched figures are reported as **unverified** rather than trusted.

Three refinements were needed to make it useful rather than noisy:

1. **Magnitude comparison.** A surplus fact of `−31000` is written "over-committed by ₹31.0k". The sign is a presentation choice; only the magnitude needs grounding.
2. **No scaled readings for currency.** Allowing a `×100` or `÷100` match bound "₹1.47 L" to an unrelated ₹1.56 Cr fact — a confident-looking false positive, which is worse than reporting the claim unverified, because it attaches the wrong evidence to a correct number. Only percentages get a scaled reading.
3. **Every narrated number is published.** Where the verifier flagged a *correct* figure, the fix was to publish the evidence, not to loosen the check. Actions carry an `evidence` map of every figure their own wording quotes, and `RetirementReadiness` publishes the exact plan inputs it used.

It runs on the deterministic path too, where grounding should always be total — making it a live regression test on the templates. A CI test asserts ≥95% grounding across seven question types.

### Retrieval: BM25, not embeddings

Fourteen curated notes on planning principles, indexed with BM25 (title and tags weighted 2×, light stemmer, best-paragraph snippet selection).

An embedding index would be correct at a few thousand documents. At fourteen it would add a network hop, a cold-start cost and an availability dependency in exchange for nothing measurable — and it would stop working in the no-credentials mode, where lexical search still functions. A test asserts seven domain queries each surface the right document in the top two.

### The deterministic fallback is not a stub

With no credentials the platform still: classifies intent across ten categories, extracts scenario levers from natural language ("retire 5 years early" → `retirementAgeDelta: -5`), publishes a plan, runs the same tools in the same order, composes a grounded answer from templates, and verifies it.

Two reasons this exists. It makes the repository clonable and demoable by anyone with no account and no cost. And it is the fallback behind every model failure — a rate limit, a refusal, an unreachable endpoint — so the product degrades to *less fluent prose* rather than to an error page. Its correctness is therefore a reliability property of the whole system, which is why it carries the majority of the agent test suite.

---

## 6. The client

React 18, Vite, React Router, Recharts. Hand-written CSS with a token layer rather than a utility framework — the token set is small, the theme switch is one attribute on `<html>`, and there is no extra build step.

**State.** One context holds the profile. The snapshot is `useMemo(() => buildSnapshot(profile))` — recomputed on every change, because it is microseconds of arithmetic and caching it would be more code and more risk than it saves. Persistence is debounced at 600 ms: a slider drag updates the UI on every frame and sends one request when it settles. A failed save keeps local state and says so, because losing an edit to a network blip is far worse than a stale server copy.

**Charts.** Form follows the data's job, not preference:

| Data | Form | Why not the obvious choice |
|---|---|---|
| Simulation bands | Sequential one-hue fan | Five categorical colours would imply five unrelated series, not nested confidence bands |
| Allocation | Horizontal stacked bar | A donut cannot be read for close values, and asset-class names do not fit in slices |
| Drift vs target | Diverging bar on zero | Two bars would make the reader subtract |
| Wellness pillars | Meters | Each is its own 0–100 scale, not a comparable series |
| Goal funding | Paired bars, one axis | A second y-axis is the classic dual-axis mistake |

**Colour was computed, not chosen.** The first hand-picked palette failed validation: violet against sky measured a colour-vision ΔE of 5.2, below the floor of 6 — genuinely indistinguishable for deuteranopes. It was replaced with a validated eight-hue palette in fixed slot order (the order *is* the safety mechanism), passing all six checks in both light and dark mode. Three light-mode steps fall below 3:1 contrast on white, which is permitted only with relief — so every chart also ships a table view.

Identity is never colour-alone: legends are always present for two or more series, gains carry signs, statuses carry labels.

---

## 7. Security and privacy

- **No API key anywhere in the deployed system.** Claude is reached through Bedrock using the Lambda execution role. There is no secret to store, rotate or leak.
- **Least privilege.** Bedrock access is scoped to `anthropic.*` foundation models and inference profiles, not `*`. DynamoDB access is scoped to the one table.
- **Private S3.** Origin Access Control only; the bucket has no public access and no website endpoint.
- **Input validation at the boundary.** Every request body is parsed by a Zod schema with bounded ranges, and rejections return field-level detail.
- **No internals leaked.** Unexpected errors return a generic 500; the stack trace goes to CloudWatch.
- **Model output is escaped before rendering.** HTML is escaped *before* Markdown formatting is applied, so the only tags in the output are the ones the renderer generates.
- **Synthetic data only.** No real market data, no account linking, no PII. The banner saying so is always visible.

---

## 8. What is deliberately not modelled

| Omission | Consequence |
|---|---|
| Taxes | Real after-tax outcomes are lower than every projection shown |
| Transaction costs | Rebalancing looks free; it is not |
| Fat tails and autocorrelation | Log-normal independent draws understate real crash severity and clustering |
| Drawdown sequencing | Retirement drawdown uses a fixed real return, not a simulated path |
| Life events | Illness, divorce, inheritance, business failure are absent |
| Behaviour | Projections assume contributions continue through every drawdown. Most people stop. |

These are listed in the product, on the Assumptions page, not only here.

---

## 9. Bugs found and fixed during the build

Recorded because the interesting part of a build is usually what was wrong first.

| Bug | Symptom | Cause and fix |
|---|---|---|
| Risk capacity overstated | Early-career persona scored 72/100 capacity with six weeks of savings and 42% card debt | A weighted average let a 34-year horizon outvote a disqualifying buffer. Added knock-out caps. |
| Diversification overstated | 97/100 for a portfolio with 31% in one stock | `(1 − HHI)` is too generous, and fund positions were counted as concentration risk. Rescored on effective positions plus largest *security*. |
| Crash scenario had no effect | A 35% drawdown changed the retirement corpus by exactly zero | The shock was threaded into goal projection and Monte Carlo but not into retirement sizing. Factored into a shared `accumulate()` helper. |
| Simulation contradicted the projection | "78% funded" beside "1% of paths reach the target" | The Monte Carlo reconstructed its own inputs and modelled a weaker plan. `RetirementReadiness` now publishes the exact inputs it used. |
| Lambda bundle died on startup | Clean typecheck, clean build, `ERR_MODULE_NOT_FOUND` at boot | tsup externalised the workspace package, whose TS source uses `.js` specifiers Node cannot resolve. Added `noExternal`. This is why CI runs a smoke test against the built artefact. |
| Percentage lever misparsed | "cut spending by 15%" applied a 5% cut | Greedy regex backtracking matched the trailing digit. Anchored the digit group with `\b`. |
| Verifier false positives | "₹53.58 L" reported as an unverified "₹53.58" | The plain-currency lookahead omitted the bare `L` suffix, double-matching the amount. |
| Imperative commands misrouted | "Increase my Retirement contribution to 45000" answered instead of applied | Keyword matching cannot separate a command from a question. Added imperative-mood detection with a hedge check. |

---

## 10. Where this would go next

Honest about what is missing rather than claiming completeness.

**Needed before real users.** Cognito authentication with per-user data isolation; encryption of financial fields with a customer-managed key; WAF and per-user rate limiting in front of the API; an audit log of every recommendation shown and every plan change applied.

**Needed for real data.** Account aggregation to replace manual entry; live prices; tax modelling, which is the single largest gap between these projections and reality.

**Would improve the AI.** An eval set over the agent's answers scored for grounding, correctness and tone, so prompt changes can be measured rather than eyeballed. Prompt caching on the system prompt and tool definitions, which are byte-stable and would cut per-turn cost materially. A cheaper model for intent classification, keeping the capable one for advice.

**Would improve the product.** A household view, since money decisions are rarely individual. Goal dependencies (retirement is not independent of funding a child's education). Behavioural nudges based on what the user actually did versus what they said they would.
