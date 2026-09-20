# API Reference

Base URL: `/api` (same origin as the app in both local and deployed setups).

All request bodies are JSON and validated against a Zod schema with bounded ranges. A validation failure returns `400` with field-level detail:

```json
{
  "error": "Request body failed validation",
  "details": [{ "path": "age", "message": "Number must be greater than or equal to 16" }]
}
```

Unexpected errors return `500` with `{"error":"Internal server error"}` — the stack trace goes to CloudWatch, never to the client.

---

## Health and metadata

### `GET /api/health`

Liveness, plus which reasoning engine is active.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "engine": "bedrock",
  "model": "claude-opus-5",
  "time": "2026-09-20T08:22:17.667Z"
}
```

`engine` is `bedrock`, `anthropic` or `deterministic`. The UI surfaces this so it is never ambiguous which engine produced an answer.

### `GET /api/ready`

Readiness, including the store. A broken table shows up here rather than as a mystery 500 later.

```json
{ "status": "ready", "store": "dynamodb", "engine": "bedrock" }
```

`store` is `dynamodb` or `memory`. Returns `503` if the store cannot be reached at all.

### `GET /api/meta/assumptions`

The full assumptions ledger and the risk questionnaire. Published as an endpoint because "make assumptions visible" only means something if they are inspectable from outside the UI.

---

## Profiles

### `GET /api/profiles/personas`

The three synthetic personas, each with the planning problem it illustrates.

### `GET /api/profiles/risk-questions`

The six-question risk profiler. The client never hardcodes it.

### `POST /api/profiles`

Creates a profile, blank or seeded from a persona. A seeded profile gets a fresh id, so two sessions never share state.

```json
{ "personaId": "meera", "displayName": "Optional" }
```

`201` → `{ "profile": UserProfile, "snapshot": FinancialSnapshot }`. Unknown `personaId` → `404`.

### `GET /api/profiles/:id`

The stored profile. `404` if unknown.

### `PUT /api/profiles/:id`

Full replace. The client holds the whole profile, so `PUT` is the honest verb. Rejects a `retirementAge` at or below `age`.

### `PATCH /api/profiles/:id`

Partial update — a slider should not round-trip the entire balance sheet.

```json
{ "liquidSavings": 800000 }
```

Arrays (`holdings`, `liabilities`, `goals`) replace wholesale when present; merging them by index would be ambiguous and would silently corrupt a deletion.

### `DELETE /api/profiles/:id`

Deletes the profile and its conversation history. `204`.

### `GET /api/profiles/:id/snapshot`

**The main read.** Everything the dashboard renders, in one call: net worth, cashflow, portfolio analytics, risk profile, recommended allocation, every goal projection, retirement readiness, wellness score, ranked actions, and the assumptions used.

### `POST /api/profiles/:id/risk`

Scores the questionnaire. Does not persist unless asked, so the UI can give live feedback while the user is still deciding.

```json
{ "answers": { "drawdown": 3, "horizon": 2 }, "persist": false }
```

---

## Planning

### `GET /api/plan/presets`

The seven built-in what-if scenarios with their levers.

### `POST /api/plan/:id/scenario`

Runs one scenario and returns the outcome, the delta against the current plan, per-goal projections, a Monte Carlo result and a plain-language explanation.

```json
{
  "levers": {
    "extraMonthlySavings": 20000,
    "expenseMultiplier": 0.9,
    "retirementAgeDelta": -5,
    "lumpSum": 300000,
    "marketShockPct": -0.35,
    "shockYear": 3,
    "careerBreakMonths": 12,
    "incomeGrowthPct": 0.08,
    "inflationPct": 0.08
  },
  "label": "Optional",
  "paths": 2000,
  "seed": 20260920
}
```

Every lever is optional; omitted means unchanged. All are range-bounded (`marketShockPct` is limited to −0.9…0.9, for example). Pass `seed` for a reproducible result.

### `POST /api/plan/:id/scenarios/compare`

Runs up to six scenarios against **one shared baseline** and returns them with the baseline. Sharing the baseline is deliberate: recomputing it per scenario would be wasted work and would let the comparison drift.

### `POST /api/plan/:id/goals/:goalId/project`

Projects one goal, optionally with a test contribution or lump sum layered on.

```json
{ "extraMonthly": 10000, "lumpSum": 200000 }
```

Returns the inflation-adjusted target, projected corpus, shortfall, the contribution that would exactly fund it, the return that would close the gap instead (or `null` when none would), and the assumptions used.

### `POST /api/plan/:id/monte-carlo`

Standalone simulation on the retirement plan. Defaults come from the retirement projection's own inputs, so the probability describes the same plan the rest of the platform shows.

```json
{ "years": 20, "riskBucket": "Growth", "paths": 5000, "realTerms": true }
```

Returns percentile bands per year, success probability, a histogram of terminal values, the seed, and the assumptions — including what the simulation does *not* model.

### `POST /api/plan/:id/debt-plan`

Avalanche versus snowball, with the interest and months each saves.

```json
{ "extraMonthly": 10000 }
```

### `GET /api/plan/:id/impact?top=3`

What following the top-ranked actions is actually worth. Returns `before` and `after` metrics — wellness score and grade, retirement funded, goals on track, interest paid and months to debt-free, median corpus at retirement, emergency cover, monthly surplus — plus `applied`, each action's **marginal** contribution with the ones above it already in place, and `notModelled`, everything excluded and why.

Two rules keep the figure honest, and both are visible in the response:

- **Only actions the platform can carry out are counted.** Four of the fifteen rules carry a machine-applicable mutation; the rest need the user to buy a policy, refinance or open an account. Those arrive in `notModelled` rather than inside the headline.
- **Only actions the user can fund are counted.** The `fund-goal-*` rules mutate a contribution by the whole monthly gap regardless of surplus. Counted naively that reported "retirement funded 41% → 459%" for a profile already running a deficit. An action that would push the surplus below zero is excluded, with the arithmetic in its `why`.

Deterministic: the simulation is seeded, and the mutations use fixed ids, so the same plan always reports the same numbers. `top` is clamped to 1–10 and counts *applicable, affordable* actions, so the walk continues down the ranked list until it finds that many.

### `GET /api/plan/:id/allocation?years=20`

The five model portfolios with their expected return and volatility, so the recommended mix can be compared against the alternatives rather than simply asserted.

---

## Agent

### `GET /api/agent/capabilities`

What the agent can do: the active engine, the step ceiling, every tool with its description, and the knowledge-base index. Used by the UI's capability panel.

### `GET /api/agent/:id/stream?message=...&sessionId=...`

**Server-Sent Events.** The streaming ask, and what the UI uses.

`GET` rather than `POST` so the browser's native `EventSource` works; the message rides in the query string, which is why it is capped at 2,000 characters.

Event types, in the order they typically arrive:

| Event | Payload |
|---|---|
| `run_started` | `{ runId, at }` |
| `plan` | `{ steps: AgentPlanStep[], rationale }` — re-emitted as steps change status |
| `thought` | `{ text }` |
| `tool_call` | `{ id, tool, input, label }` |
| `tool_result` | `{ id, tool, summary, data, ms }` |
| `retrieval` | `{ query, hits: [{ title, score, snippet }] }` |
| `token` | `{ text }` — one per streamed text delta |
| `verification` | `{ checks: [{ claim, status, evidence }] }` |
| `final` | `{ message: AgentMessage }` |
| `error` | `{ message, recoverable }` |
| `done` | `{}` — terminates the stream |

A comment frame (`: ping`) is sent every 15 seconds so intermediaries do not time out a quiet stream.

```bash
curl -N "http://localhost:4000/api/agent/$PROFILE/stream?message=How%20am%20I%20doing"
```

### `POST /api/agent/:id/ask`

Non-streaming equivalent, for tests and integrations.

```json
{ "message": "What should I do next?", "sessionId": "optional" }
```

Returns the answer **and the trace**, so a non-streaming client still gets the explainability rather than just the prose:

```json
{
  "sessionId": "session-...",
  "message": {
    "content": "...",
    "citations": [{ "kind": "tool", "ref": "get_financial_snapshot", "label": "..." }],
    "assumptions": [{ "label": "Inflation", "value": "6.0%/yr", "source": "market_assumption" }],
    "plan": [{ "tool": "get_financial_snapshot", "goal": "...", "status": "done" }],
    "toolCalls": [{ "tool": "get_financial_snapshot", "label": "...", "ms": 3 }],
    "verification": [{ "claim": "₹44.48 L", "status": "grounded", "evidence": "Matches \"net worth\" from tool output" }],
    "attachments": [{ "kind": "scenario", "data": {} }],
    "engine": "bedrock"
  },
  "trace": []
}
```

### `GET /api/agent/:id/sessions` · `GET /api/agent/sessions/:sessionId`

List a profile's conversations, or fetch one with its full message history.

The list returns `{ id, createdAt, updatedAt, messageCount, preview }` per conversation — enough for a history sidebar without pulling every message. The single-session read returns the whole `ChatSession`, and each assistant turn carries its own `plan`, `toolCalls`, `verification`, `citations`, `assumptions` and `attachments`. A reopened conversation is therefore as auditable as a live one; tool *summaries* and inputs are not persisted, so a restored trace shows which tools ran and how long each took, but not what each returned.

### `DELETE /api/agent/sessions/:sessionId`

Deletes one conversation. `204`.

Idempotent by design: deleting an unknown or already-deleted id also returns `204`, never `404`. The client removes the row optimistically and retries on a dropped response, so a second delete must not report an error for work that already succeeded.

### `GET /api/agent/knowledge?q=...&limit=3`

BM25 search over the knowledge base. Omit `q` to list every document. Exposed so the UI can show what grounds an answer.

---

## Agent tools

The thirteen tools the agent can call. Each wraps the shared engine — the model chooses *which* questions to ask and *how* to explain the answers; it never computes a number itself.

| Tool | What it does |
|---|---|
| `get_financial_snapshot` | The complete position. Called first for almost any question. |
| `project_goal` | Projects one goal and reports the funding gap three ways |
| `simulate_scenario` | Runs a what-if with the full lever set, including a Monte Carlo |
| `run_monte_carlo` | Standalone simulation, for probability questions |
| `analyze_portfolio` | Allocation, risk, fees, drift, concentration, rebalancing trades |
| `recommend_allocation` | The target mix for a risk level and horizon, with its reasoning |
| `get_next_best_actions` | The ranked action list with quantified impact |
| `plan_debt_payoff` | Avalanche versus snowball |
| `compare_scenarios` | Runs several options and ranks them on one basis |
| `search_knowledge` | Retrieves the planning principle behind a recommendation |
| `update_plan` | Applies a change the user explicitly asked for |
| `list_scenario_presets` | What the user can explore |
| `estimate_action_impact` | What following the top actions is worth, before and after, with each one's marginal contribution |

Each returns three things: a `summary` for the trace and for the model to reason over, `data` for the UI to render as a card, and `facts` — every number the tool produced, which the grounding verifier uses to check the final answer.

---

## Type definitions

All request and response shapes are exported from `@wealth/shared`:

```ts
import type {
  UserProfile, FinancialSnapshot, GoalProjection, MonteCarloResult,
  PortfolioAnalysis, ScenarioLevers, ScenarioResult, NextBestAction,
  RiskProfile, AgentEvent, AgentMessage, Assumption, VerificationCheck,
} from '@wealth/shared';
```

`packages/shared/src/types.ts` is the single source of truth and is documented inline.
