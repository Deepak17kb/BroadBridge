# AI Wealth Navigator — Implementation Brief

You are working on **AI Wealth Navigator**, an existing npm-workspaces monorepo
(`packages/shared`, `packages/server`, `packages/web`, `infra`).

Current state: React 18 + Vite 6 client, Express 4 + Zod API, a shared TypeScript financial
engine imported as source by both sides, a PLAN→ACT→SYNTHESIZE→VERIFY agent with 12 tools and
BM25 retrieval, an AWS CDK stack (CloudFront + S3 + HTTP API + Lambda + DynamoDB + Bedrock),
and 117 passing tests across ~16,700 lines.

This document is your work queue. Execute it.

---

## AUTONOMY PROTOCOL — read this first

**Work independently. Do not ask for approval to do your job.**

You do not need permission to plan, to read files, to write code, to create files, to run tests,
to run the linter, to fix what you broke, to name a variable, to pick a file path, to write copy,
or to move from one task to the next. Decide and proceed. If a detail in this brief is
underspecified, choose the option most consistent with the existing codebase and note the choice
in the progress log. Do not stop to ask which one I prefer.

Work through the tasks in the order given in the **Execution order** section. When a task is
complete, commit it and start the next one without checking in.

### Stop and ask only for these

1. **Anything that spends money or touches live AWS.** `cdk deploy`, `cdk destroy`, creating
   AWS resources, Bedrock calls against a real account, anything requiring credentials.
   Write and `cdk synth` the infrastructure freely; do not deploy it.
2. **Anything involving a git remote.** `git init`, branches, and local commits are yours.
   Creating a remote, pushing, force-pushing, or rewriting published history is not.
3. **New runtime dependencies.** Dev-only tooling already implied by a task (Playwright,
   axe-core, k6) is fine. Anything that ships to the browser or the Lambda bundle: ask, with the
   package name, its size, and why nothing already installed will do.
4. **Deleting or weakening an existing test.** If an existing test now fails, the default
   assumption is that your code is wrong. If you genuinely believe the test encoded a wrong
   expectation, stop and show me the test, the failure, and your reasoning.
5. **Destructive filesystem or data operations.** Deleting directories, `rm -rf`, dropping a
   table, truncating a data file, mass find-and-replace across the repo.
6. **A breaking change to the `@wealth/shared` public API.** Additive changes are yours.
   Changing or removing an exported signature that other packages consume: ask.
7. **Security model decisions in T11.** Building Cognito, the authorizer, and the scoping is
   yours. But before you start T11, show me the two-paragraph threat model you intend to
   implement and wait. That task changes every route and I want to see the shape first.
8. **Scope reality check.** If a task turns out to be more than roughly twice the work this
   brief implies, stop, say so, and propose a smaller version. Do not silently spend a day on
   something described in three lines.

Anything not on that list: just do it.

### Keep a progress log

Maintain `PROGRESS.md` at the repo root. After each task, append:

```
## T<n> — <title>  [done | partial | blocked]
Files touched:
Decisions I made without asking:
Tests added (and the real `npm test` output line):
Anything I deliberately left out:
```

Add a `## BLOCKED` section at the top for anything from the stop list that is waiting on me.
Keep working on other tasks while something is blocked — never idle waiting for an answer.

### Never claim something works without proof

Do not write "done", "working", or "passing" without running the thing and pasting the real
output. Not a summary of the output. The output. A task is complete when `npm test`,
`npm run lint`, and `npm run typecheck` all pass and you have shown that they did.

---

## HARD CONSTRAINTS — these override any task below

1. **One engine.** All financial math lives in `@wealth/shared`. Never implement a calculation
   in the server or the client. If you find yourself writing a projection, an annuity, a
   percentile, or a rate conversion outside `packages/shared`, stop and put it in the engine.
   The "no second implementation to drift" property is the most valuable thing in this codebase.
2. **Deterministic mode must never break.** Every feature must work end-to-end with zero
   credentials using the rule-based path. No feature may *require* a model.
3. **117 tests stay green**, and the count only goes up.
4. **Zero ESLint warnings**, clean `tsc`, clean `cdk synth`.
5. **Every number is explainable.** Any figure shown to a user traces to a visible assumption.
   New tunables go in `assumptions.ts` and appear in the Assumptions ledger UI.
6. **Agent output stays grounded.** New tools return `summary` (trace) + `data` (UI card) +
   `facts` (verifier). The model narrates, it never calculates.
7. **Synthetic data only.** Labelled as synthetic in-file and in-UI.
8. **Do not refactor what the task did not ask you to touch.** No reorganising, no renaming
   for consistency, no "while I was in here". If you spot something wrong outside your task,
   note it in `PROGRESS.md` and move on.
9. **One task per branch**, conventional commit messages, commit when the task's tests pass.

Also create `CLAUDE.md` at the repo root as your first action, containing constraints 1–9 above
plus the autonomy protocol summary, so these survive context resets.

---

## T1. Version control and a deployable pipeline

The project is not currently a git repository, so the GitHub Actions workflows and the deploy
pipeline cannot run at all.

**Yours:**
- `git init`; write a proper `.gitignore` (node_modules, dist, cdk.out, .env*, coverage,
  `*.tsbuildinfo`, `playwright-report`, `test-results`, `.DS_Store`); initial commit.
- Audit the existing workflows and fix anything that would fail: the CI gate
  (lint → typecheck → test → build → `cdk synth` → artefact upload), the API smoke-test job,
  the dependency audit, and `buildspec.yml`.
- Write the OIDC deploy workflow and the least-privilege IAM trust policy as code. Document
  exactly which repo variables I need to set.
- Add CI/deploy badge markup to the README with placeholder URLs.

**Blocked on me:** creating the GitHub remote, the first push, creating the AWS IAM role, and
`cdk deploy`. Prepare all of it, put the exact commands I need to run in `PROGRESS.md`, and
move on to T2.

---

## T2. Health cover rule — close the dangling data loop

`healthInsuranceCover` is collected in onboarding, collected again in the profile editor, and
typed on `UserProfile` — and no rule ever reads it. Life cover has `close-life-cover-gap`;
health cover has nothing.

- New rule `close-health-cover-gap`, placed immediately after `close-life-cover-gap` in the
  waterfall. Rule count goes 14 → 15.
- Need model, with every constant in `assumptions.ts` and editable in the ledger:
  `target = max(annualIncome × healthCoverMultiple, floorByAgeBand)`, adjusted upward per
  dependent and by age band. Gap = target − existing cover. No action when the gap is ≤ 0.
- The action carries what every other rule carries: `why` in the user's own numbers, quantified
  impact (out-of-pocket exposure avoided, **and** the knock-on effect on the emergency-fund
  target, since an uninsured medical event drains it), effort level, ordered steps, assumptions
  used, evidence figures.
- Urgency escalates with dependents and with zero existing cover.
- Update the README (it currently says "Thirteen rule checks" — it is wrong twice over), the
  Actions page copy, the published ranking explanation, and every test asserting a rule count.
- Tests: under-insured persona triggers it with the correct gap; adequately covered persona does
  not; zero cover with dependents ranks urgent; correct waterfall position.

---

## T3. Surface what is already built

UI-only work against endpoints and client methods that already exist and already work.

- **Chat history.** `GET /api/agent/:id/sessions` and `/sessions/:sessionId` exist; `api.sessions()`
  and `api.session()` exist in the web client; the Assistant page only tracks the live session id.
  Build a collapsible conversation list, click-to-reload a past session (trace and attachments
  included), a "New chat" button, and delete-session.
- **Server-side scenario comparison.** `POST /api/plan/:id/scenarios/compare` handles up to 6
  scenarios; the Scenario Lab pins 3 and compares client-side. Use the endpoint, raise the pin
  limit to 6.
- **The risk ladder.** `GET /api/plan/:id/allocation` returns all 5 model portfolios with return
  and volatility, rendered only on Portfolio. Add it to the Assumptions page (so a user sees what
  their edits do to every portfolio) and to the Scenario Lab allocation-override control.

---

## T4. The "value created" hero metric

You can already compute what following the advice is worth, and you show none of it. This becomes
the first thing anyone sees on the dashboard.

- New `packages/shared/src/impact.ts`:
  `computeActionImpact(profile, snapshot, actions, topN)` clones the profile, applies the top N
  actions **using the existing mutation appliers** (no second implementation), re-runs
  `buildSnapshot`, and returns before/after for: wellness score and grade, retirement funded %,
  goals on track, total interest paid and months to debt-free, p50 corpus at retirement (seeded
  Monte Carlo), emergency cover months.
- Apply cumulatively in rank order and report each action's **marginal** contribution, so the
  breakdown adds up.
- Only 4 of the 15 rules are machine-applicable. Exclude the rest from the headline number and
  list them separately as "not modelled here". The headline must never be overstated.
- `GET /api/plan/:id/impact?top=3`.
- Dashboard hero card: *"Following your top 3 actions: retirement funded 61% → 88% · ₹4.2L
  interest saved · debt-free 4 years sooner"*, expandable to the per-action breakdown with the
  assumptions listed underneath.
- Expose as an agent tool fact so the assistant can cite it.
- Tests: non-zero and directionally sane for all 3 personas; idempotent; a fully optimised profile
  returns a zero-impact result without dividing by zero.

---

## T5. Goal-priority optimiser

Goals compete for one surplus and nothing allocates it — each gap is reported in isolation. This
is the strongest differentiator available and it depends on nothing above.

**New `packages/shared/src/optimiser.ts`:**

```
allocateSurplus(goals, surplus, assumptions, horizonContext) => {
  allocations: Array<{ goalId, requiredMonthly, allocated,
                       resultingFundedRatio, onTrack, shortfallAfterAllocation }>,
  unallocated: number,
  starved: Array<{ goalId, unmetMonthly, yearsDelayIfUnfunded }>,
  rationale: string,
  assumptions: AssumptionRef[]
}
```

**Algorithm (deterministic, closed-form, no search):**
1. Compute `requiredMonthly` per goal with the existing solver, respecting per-goal inflation
   overrides and per-goal return by that goal's own horizon. Do not use a blended return.
2. Score each goal `priorityWeight × urgency × deficit`, where `urgency = 1 / max(yearsToGoal, 0.5)`
   and `deficit = 1 − fundedRatio`. Weights live in `assumptions.ts`, editable and visible.
3. Fill greedily in score order, capping each goal at its `requiredMonthly`.
4. **Near-term floor:** goals within 24 months of their target fund before longer-horizon goals of
   equal priority regardless of score — a near-term goal cannot be rescued later.
5. Surplus remaining after all goals are funded routes to the retirement gap, then to the existing
   `deploy-idle-cash` path.
6. Every under-funded goal appears in `starved` with the consequence expressed in **years of
   delay**, not just rupees.

**Then:**
- Unit tests: allocation sums exactly to surplus; no goal exceeds its required monthly; priority
  order respected; near-term floor respected; edge cases (zero surplus, negative surplus, one
  goal, all funded, a goal whose requirement exceeds the whole surplus).
- `POST /api/plan/:id/optimise-goals` with optional `surplusOverride`.
- New agent tool `optimise_goal_funding` (12 → 13 tools), wired into the tool registry, the
  `goal` and `actions` intents, and the verifier facts.
- Goals page section **"Where your surplus should go"**: stacked allocation bar, per-goal table of
  allocated vs required, an explicit "what this costs you" line per starved goal, and an
  **Apply this allocation** button reusing the existing apply-to-plan mutation path.

**Acceptance:** for the Meera persona the optimiser produces a non-obvious allocation and the UI
states the tradeoff in one sentence a non-expert understands.

---

## T6. External / sample data integration

The platform has no external data source of any kind — every price is user-entered. Integration
with an external or sample data source is an explicit platform requirement currently scoring zero.

**T6a — Sample market data provider**
- `packages/server/src/marketdata/`: a `MarketDataProvider` interface
  (`getPrices(symbols)`, `getHistory(symbol, days)`), and a `SampleFileProvider` reading
  `data/market/prices.json` from local disk, or from the S3 data prefix when deployed. In-memory
  cache with a short TTL. Selected by `MARKET_DATA_SOURCE=sample|none`, following the existing
  three-run-mode pattern. Keep it to two files; do not build a registry or an adapter layer.
- `GET /api/market/prices?symbols=`, `GET /api/market/history/:symbol?days=`,
  `POST /api/profiles/:id/refresh-prices` — the last returns a diff (per-holding old/new, change
  in unrealised gain, net worth, and drift).
- Portfolio page: a **Refresh prices** button, an unmissable "as of <date> · sample data" label,
  a diff toast summarising what moved, and a per-holding sparkline.
- A provider failure must never 500 a page. Degrade to user-entered prices with a visible notice.

**T6b — File import**
- `POST /api/import/holdings` and `POST /api/import/transactions`, accepting CSV text in the body.
  Parse and Zod-validate per row.
- **Two-step commit.** The import endpoint returns a *preview* only: parsed rows, detected columns,
  and a per-row status of `ok | warning | error` with a reason. Nothing is written until
  `POST /api/import/:token/commit` with the accepted row ids.
- Transaction import derives expense categories from a keyword map held in
  `data/import/keyword-map.json` (reviewable data, not code) and detects salary credits to
  pre-fill income.
- Tolerant header detection: case-insensitive, common aliases (`Qty`/`Units`/`Quantity`,
  `Avg Cost`/`Cost Basis`/`Buy Price`).
- UI: drag-and-drop on the onboarding "What you own and owe" step and in My Details, with a
  preview table, per-row accept/reject, and the reason for every warning.
- Tests: malformed rows, missing headers, duplicate symbols, negative units, unparseable dates,
  empty file, and a bounded row limit returning a clean 400.

---

## T7. Time, history, and the proactive agent

The platform has no concept of history, so nothing about it is actually proactive. "Proactive
guidance" is the core of the problem statement.

**T7a — Snapshots**
- DynamoDB, existing single table: `pk = PROFILE#<id>`, `sk = SNAPSHOT#<iso-date>`, with the `ttl`
  attribute **actually written** (400 days) — it is currently configured and never set.
- Write on material profile change, throttled to one per profile per day (same-day overwrites).
  Capture: wellness score and all 5 pillars, net worth, monthly surplus, savings rate, emergency
  months, retirement funded %, goals on track, total shortfall, allocation weights, blended
  expense ratio, total debt.
- `GET /api/profiles/:id/history?from=&to=&granularity=month`. Query by key, never scan.
- Dashboard **Progress** section: sparkline of wellness score and net worth, "since last month"
  deltas on each headline stat, and an honest neutral state when there is no prior snapshot.
  Do not invent a baseline.

**T7b — Scheduled proactive review (second agent workflow)**
- CDK: an EventBridge weekly schedule → a `review.ts` Lambda handler sharing the server bundle.
- Per profile: load the latest snapshot and the one ~30 days prior, diff them, and run the agent in
  a **review** mode answering "what changed and what should this person do about it". In
  deterministic mode this uses the template synthesiser, so it works with no credentials.
- Store `sk = DIGEST#<iso>`: top 3 material changes with before/after numbers, the highest-ranked
  action, a one-paragraph plain-language summary, assumptions used, `read` flag, TTL 180 days.
- `GET /api/profiles/:id/digests`, `PATCH .../digests/:id` (mark read).
- Shell inbox with an unread count. A digest should read like a short letter from an advisor.
- Must be manually invocable via `npm run review:local` so it is testable without waiting a week.
- SES email delivery behind a flag, off by default, synthetic addresses only.

---

## T8. Life-event scenarios

The 9 levers are powerful but abstract. Users think in life events.

- First extend `runScenario` in the shared engine with any missing levers: `addLiability`
  (kind, principal, rate, tenure, startYear), `addGoal`, `removeGoalId`, `recurringExpenseDelta`
  (amount, startYear, endYear), `incomeStepChange` (multiplier, startYear).
- Add composite presets to `SCENARIO_PRESETS`, each with a `narrative` (what the event means in
  words) and an `affects` list (which levers it pulls and why), so the UI explains before it
  calculates:
  - **New child in 2028** — recurring expense, a new education goal, reduced surplus, higher
    life-cover need.
  - **Buy a home** — down-payment lump sum out, new home-loan liability with EMI, removal of the
    house goal, revised emergency target.
  - **Job loss for 9 months** — career break plus an expense trim; tests emergency cover.
  - **Supporting a parent** — ongoing recurring expense from a chosen year.
  - **Promotion** — income step change plus contribution step-up.
  - **Retire at 50** — retirement age delta plus a de-risked allocation override.
- A test per preset: no NaN/Infinity reaches output, deltas move in the expected direction.
- Scenario Lab groups presets as **Quick levers** vs **Life events**, narrative above the numbers.

---

## T9. Agent write-path with human confirmation

The assistant answers. Making it propose and execute is what separates an agent from a chatbot,
and the mutation machinery already exists.

- `update_plan` **never mutates directly**. It returns a `proposal`: typed mutations (the 4
  machine-readable types plus the T5 optimiser allocation) with computed before/after for wellness
  score, retirement funded %, goals on track, and monthly surplus.
- New SSE event type `proposal`; document it in `docs/API.md`.
- UI: a proposal card with a diff table (field, before, after, delta) and **Approve** / **Reject**.
  Nothing changes until approved.
- `POST /api/plan/:id/apply` re-validates every mutation server-side against allowed types and
  bounded ranges, with field-level 400s. **Never trust the client's copy of the proposal** —
  re-derive it from the stored proposal id.
- Audit trail: `sk = MUTATION#<iso>` with the proposal id, the mutations, and before/after.
  Surface as a "what changed and why" list in My Details, tying into T7's history.
- Tests: agent proposes without mutating; apply validates and persists; a forged mutation type is
  rejected; a rejected proposal leaves the profile byte-identical.

---

## T10. Rate limiting, WAF, and cost guardrails

The agent endpoints call a paid model and run 2,000-path simulations. Both are wide open.

- Token-bucket limiter (DynamoDB counter with TTL; in-memory locally) on `/api/agent/*`,
  `/api/plan/:id/monte-carlo`, `/api/plan/:id/scenarios/compare`, and the import endpoints.
  Per-user and per-IP, configurable, clean 429 with `Retry-After`.
- API Gateway stage throttling in CDK as a second layer.
- AWS WAF web ACL on CloudFront: managed common rule set, rate-based rule, body size restriction.
- Cap `SIMULATION_PATHS` server-side regardless of what the request asks for.
- **Bedrock cost guard:** enforce max tokens and the existing 6-step ceiling, plus a per-user daily
  invocation cap in DynamoDB with a TTL. On exceeding it, **fall back to the deterministic engine
  rather than erroring** — the user still gets a complete, correct answer with a notice. A cost
  control that degrades into a feature.
- Surface the guard state in `/api/agent/capabilities` so the UI can show remaining quota.
- Tests: 429 after N requests in the window; the fallback engages at the cap and still produces a
  grounded answer.

---

## T11. Authentication and per-user scoping

`GET /api/profiles` lists every profile in the system, and any caller can read, overwrite, or
delete any profile by id. This is the first thing a technical reviewer will try.

**Before writing code: post your threat model in `PROGRESS.md` and stop.** Two paragraphs —
what is protected, what is deliberately open, and how the demo path stays safe. Then wait.

Once approved:
- CDK: Cognito user pool with hosted UI (email + password, no social providers), an app client,
  and a JWT authorizer on the HTTP API.
- Add an `owner` attribute (Cognito `sub`) to every profile item; key the listing GSI on `owner`
  so it never scans.
- Scope every profile, plan, agent, import, market, history, and digest route to the caller's
  `sub`. Cross-owner access returns **403** consistently — do not mix 403 and 404 across routes.
- Client: auth context, login/signup/forgot screens, silent refresh, logout, and a route guard
  that composes with the existing profile guard in `App.tsx`.
- **Keep a first-class demo path:** a clearly labelled "Try the demo" button provisioning an
  ephemeral anonymous profile with a 24-hour TTL and harder rate limits. Nobody should have to
  sign up to see the product.
- Tests: unauthenticated → 401; cross-user → 403; demo path provisions and expires; the T12 share
  link remains publicly readable by design.

---

## T12. Export and share

- `GET /api/plan/:id/export.csv` — holdings, liabilities, goals, ranked actions, and the full
  assumptions ledger.
- **Plan PDF:** prefer a print-optimised route (`/plan/print`) plus a real `@media print`
  stylesheet over a heavy server-side renderer. Order: cover (name, date, engine used,
  "illustrative, not advice"), position summary, wellness pillars, goals with projections, the T5
  surplus allocation, top 5 actions with steps and evidence, the assumptions ledger, and the
  deliberately-not-modelled list verbatim.
- **Share link:** `POST /api/scenarios/share` stores the scenario, its output, and the baseline
  under `pk = SHARE#<nanoid>` with a 7-day TTL and returns a read-only `/s/:token`. That page
  renders **without auth and without any PII** — no name, no absolute income, no holdings, only
  scenario outputs and deltas. Assert this explicitly in a test.
- Export menu in the shell; Share button on each pinned scenario.

---

## T13. Retrieval upgrade and Bedrock Guardrails

- `packages/server/src/agent/knowledge/embeddings.ts`: Bedrock Titan Embed Text v2, embedding the
  14 corpus documents at cold start, cached in memory and optionally in DynamoDB keyed by content
  hash. Cosine search.
- Hybrid scoring: normalise BM25 and cosine to 0–1, blend with a configurable weight.
  `RETRIEVAL_MODE=bm25|vector|hybrid`, defaulting to `hybrid` when credentials exist and falling
  back to `bm25` automatically on any error or absence of credentials.
- Show the active retrieval mode in the Assistant capability panel next to the engine badge.
- Existing BM25 accuracy tests pass unchanged in `bm25` mode; add a test that `hybrid` degrades
  cleanly to BM25 results when embeddings are unavailable.
- **Bedrock Guardrails** in CDK, attached to every `InvokeModel` call: denied topics (specific
  security or product recommendations, guaranteed returns, tax evasion, insider information),
  PII masking on input, word filters for market certainty. Grant `bedrock:ApplyGuardrail` in the
  scoped IAM policy.
- A blocked response renders as a clear, non-alarming state explaining *why* and redirecting to
  what the assistant can do. Enforce the same refusals in the intent router so deterministic mode
  behaves identically.

---

## T14. UI/UX

- **Demo mode:** a `?demo=meera` deep link loading a persona instantly with no onboarding, plus a
  skippable 6-step tour (dismissal persisted): wellness score → impact hero → an action →
  scenario lab → optimiser → assistant.
- **Skeletons and optimistic UI** on anything model-backed or network-bound, with rollback on
  failure.
- **Reframe the deterministic banner.** "Running on the deterministic engine" reads as "the AI is
  broken". Rewrite it: the numbers are exact either way, only the prose is templated.
- **Empty and error states audit** across all routes. Every empty state tells the user what to do
  next.
- **Keyboard and motion:** full keyboard navigation through the shell and the scenario levers,
  visible focus rings, `prefers-reduced-motion` respected in charts and the tour.

---

## T15. Observability

X-Ray tracing is on and nothing watches anything.

- CloudWatch dashboard in CDK: Lambda invocations / errors / duration p50 and p99 / concurrency,
  API Gateway 4xx and 5xx, DynamoDB throttles and consumed capacity, Bedrock invocations and
  throttles, plus custom metrics.
- EMF metrics from the server: `AgentRun` (engine dimension), `AgentStepCount`, `ToolLatency`
  (tool-name dimension), `UngroundedFigureRate` (from the verifier — a product metric, not just an
  ops one), `EngineMode`, `ScenarioRun`, `SimulationPaths`.
- Alarms → SNS: Lambda error rate, API 5xx rate, p99 latency, Bedrock throttles, DynamoDB
  throttles, and a spike in `UngroundedFigureRate`.
- **Write every TTL that is configured but never set:** chat sessions 30d, snapshots 400d,
  digests 180d, shares 7d, rate-limit counters 1d, ephemeral demo profiles 24h.
- Structured JSON logs with a request id propagated through the agent trace, so one conversation
  can be reconstructed from logs. Stack traces still never reach the client.

---

## T16. Testing and quality

Web tests are SSR smoke renders only — no interaction is tested anywhere.

- **Playwright E2E**, headless in CI as a separate job against a locally built app:
  load a persona → dashboard shows a non-zero impact hero → apply a life-event preset and assert
  deltas render with no NaN → run the optimiser on Goals and apply it → ask the assistant a
  question, assert a grounded figure and a proposal card, approve it, assert the sidebar action
  badge drops → import a sample CSV and commit a subset of rows.
- Interaction tests for the slider debounce (path count drops while dragging, rises on settle) and
  for Apply-to-my-plan.
- **Accessibility:** `axe-core` on every route inside the E2E pass, zero critical and serious
  violations. Expect to fix chart colour contrast, mobile-nav focus order, chart `aria`
  descriptions, and form label associations.
- **Load test:** k6 or artillery against `/api/profiles/:id/snapshot` and `/api/agent/:id/ask`.
  Record cold start, p50/p95/p99, and cost per 1,000 requests in `docs/PERFORMANCE.md`.
  (Running it against the deployed stack is blocked on me; write the script and run it locally.)
- Client error boundary posting to an API endpoint that logs to CloudWatch, plus anonymous
  product analytics events (route view, action applied, scenario run, question asked).

---

## T17. Housekeeping

- Audit every count in the docs: rule checks (15 after T2), agent tools (13 after T5), endpoints,
  routes, and the test total. The README currently says "Thirteen rule checks" and is wrong.
- `scripts/` is empty — populate it (see below) or delete it.
- `docs/DATA.md`: every synthetic dataset, how it was generated, its seed, and an explicit
  statement that no real market or customer data is used anywhere.
- `CHANGELOG.md`.

---

## DEMO DATA

T6 and T7 introduce data types that do not exist yet, so this is required work. Generate
everything with a **fixed seed**; every file carries a `_meta` block marking it synthetic.

**`data/market/prices.json`** — 12 instruments (every symbol held by Aarav, Meera and Rohan, plus
3 extras for the import and lookup flows), 180 daily closes each, generated by seeded GBM using
the per-asset-class return and volatility already in `assumptions.ts` so the sample data is
consistent with the engine's own assumptions. **Include one instrument with a ~30% drawdown in the
last 40 days, and make it Rohan's large single position** — that is what makes "refresh prices"
produce a story: concentration rises, drift breaches the rebalance threshold, and
`reduce-concentration` fires. Fields: `symbol`, `name`, `assetClass`, `currency`,
`series: [{date, close}]`, `_meta: { source: "synthetic", seed, generatedAt, disclaimer }`.

**`data/market/nav.csv`** — latest close per instrument, for the CSV path of the provider.

**`data/import/sample-holdings.csv`** — 10 rows, headers
`Symbol, Name, Asset Class, Units, Avg Cost, Current Price, Expense Ratio, Instrument Kind`.
Include **3 deliberately imperfect rows** so the preview/reject UI has something to show: a missing
current price (warn, fall back to the market provider), a duplicate symbol (warn, offer merge),
and an unparseable asset class (error with a clear reason).

**`data/import/sample-transactions.csv`** — ~200 rows over 90 days:
`Date, Description, Amount, Type`. Recognisable merchants mapping to Rent, Groceries, Transport,
Utilities, Dining, Subscriptions, Insurance, EMI. Include 3 monthly salary credits so income
detection is demonstrable and 2 irregular large debits (a medical bill, a travel booking) so the
mapper has to handle "other". Amounts should reconcile roughly to Meera's stated expenses, so
importing over that persona produces small corrections rather than nonsense.

**`data/import/keyword-map.json`** — the merchant-keyword to category map used by T6b.

**`data/history/<persona>-snapshots.json`** — 12 monthly backdated snapshots per persona, each a
real output of `buildSnapshot` run against a back-dated profile variant, never hand-written, so
they stay internally consistent with the engine. Distinct trajectories matching each story:
- **Aarav** — wellness improving steadily as the buffer builds, debt barely moving.
- **Meera** — plateau: net worth rising while goals-on-track stays flat because the surplus is
  spread too thin. This sets up the T5 optimiser exactly.
- **Rohan** — a visible dip two months ago from the drawdown baked into the price file, then
  partial recovery.

**`data/digests/`** — 2 pre-generated digests per persona so the T7 inbox is not empty on first
load. Generate them by actually running the review handler against the snapshot history.

**`scripts/seed-demo.ts`** — loads personas, snapshot history, and digests into whichever store is
configured. Idempotent, works against `MemoryStore` and a deployed DynamoDB table, takes a
`--stage` flag, prints what it wrote. Wire as `npm run seed:demo`. Add a CI job running it against
the memory store and asserting the seeded personas satisfy the snapshot invariants, so demo data
can never silently drift from the engine.

---

## EXECUTION ORDER

Work straight down this list. Do not reorder without saying why in `PROGRESS.md`.

1. `CLAUDE.md` + T1 (stop at the remote/deploy boundary, then continue)
2. T2 — health cover rule
3. T3 — surface what exists
4. T4 — impact hero
5. T5 — goal optimiser
6. T6 + its demo data
7. T7 + its demo data
8. T8 — life events
9. T9 — agent write-path
10. T10 — rate limits and cost guard
11. T11 — auth (threat model first, then stop)
12. T12 — export and share
13. T13 — retrieval and guardrails
14. T14 — UI/UX
15. T15 — observability
16. T16 — testing
17. T17 — housekeeping

If time runs out, the non-negotiable set is **T1–T7 plus the demo data**. Those move the project
from a well-engineered calculator to a product with a thesis.

---

## DEFINITION OF DONE — per task

- Tests added and passing; real `npm test`, `npm run lint`, `npm run typecheck` output shown.
- Works identically in deterministic mode with zero credentials.
- Any new assumption is user-editable and visible in the Assumptions ledger.
- Any new agent tool returns `summary` + `data` + `facts` and passes the grounding verifier.
- `docs/ARCHITECTURE.md` and `docs/API.md` updated.
- Committed on its own branch with a conventional commit message.
- `PROGRESS.md` appended with files touched, decisions made unasked, tests added, and anything
  deliberately left out.
