# Progress log

Work queue: `IMPLEMENTATION.md`. Constraints: `CLAUDE.md`.

---

## BLOCKED — waiting on you

### B1. GitHub remote and first push  (blocks: CI ever running, the README badges)

Everything is committed locally on `main`. I cannot create a remote or push.

```bash
cd "C:/Users/PIYUSH/OneDrive/Desktop/BroadBridge"

# Option A — GitHub CLI (creates the repo and pushes in one step)
gh repo create ai-wealth-navigator --private --source=. --remote=origin --push

# Option B — by hand, after creating an empty repo in the GitHub UI
git remote add origin https://github.com/<OWNER>/ai-wealth-navigator.git
git push -u origin main
```

Then replace `OWNER/REPO` in the two badge URLs at the top of `README.md`.

### B2. AWS deploy role  (blocks: the Deploy workflow)

The role is written as code — `infra/lib/github-deploy-role-stack.ts`, stack
`WealthNavigatorDeployRole-<stage>`. It synthesizes; I have not deployed it.
It needs to be deployed **once per account**, by you, with credentials:

```bash
cd "C:/Users/PIYUSH/OneDrive/Desktop/BroadBridge/infra"

# Once per account+region, if never done:
npx cdk bootstrap

# The deploy role itself. Pass your real repo, or the trust policy is worthless.
npx cdk deploy WealthNavigatorDeployRole-staging \
  -c stage=staging \
  -c githubRepo=<OWNER>/ai-wealth-navigator

# If the account ALREADY has a GitHub OIDC provider (only one per issuer is
# allowed per account), pass it instead of letting the stack create one:
#   -c oidcProviderArn=arn:aws:iam::<ACCOUNT>:oidc-provider/token.actions.githubusercontent.com
```

The stack outputs `DeployRoleArn`. Set it in GitHub:

| Kind | Name | Value |
|---|---|---|
| Secret | `AWS_DEPLOY_ROLE_ARN` | the `DeployRoleArn` output |
| Variable | `AWS_REGION` | e.g. `ap-south-1` (defaults to `ap-south-1` if unset) |
| Environment | `staging` / `prod` / `dev` | must exist for `workflow_dispatch`; the trust policy names them |

The role trusts exactly two subjects per stage — `repo:<OWNER>/<REPO>:ref:refs/heads/main`
and `repo:<OWNER>/<REPO>:environment:<stage>` — and carries no AWS permissions of
its own beyond assuming the four CDK bootstrap roles and reading the bootstrap
version parameter. A deploy therefore runs with exactly what `cdk bootstrap`
provisioned, and revoking the pipeline is one role deletion.

### B3. Application deploy  (blocks: nothing — the app runs locally)

```bash
cd "C:/Users/PIYUSH/OneDrive/Desktop/BroadBridge"
npm run build
cd infra && npx cdk deploy WealthNavigator-staging -c stage=staging
```

Requires Claude model access enabled in Amazon Bedrock for the region. Without
it the deploy still succeeds and the platform runs its deterministic engine —
the deploy workflow prints a warning saying so.

---

## T1 — Version control and a deployable pipeline  [done]

**Files touched**
- `CLAUDE.md` (new) — constraints 1–9 + autonomy protocol, so they survive a context reset
- `.gitignore` (rewritten) — node_modules, dist, build, cdk.out, `.env*` (with
  `!.env.example`), coverage, `*.tsbuildinfo`, playwright-report, test-results,
  `*.tmp.ts`, logs, OS files
- `.gitattributes` (new) — `* text=auto eol=lf`
- `.eslintrc.cjs` — added `*.tmp.ts`, `*.tmp.tsx` to `ignorePatterns`
- `infra/lib/github-deploy-role-stack.ts` (new) — OIDC provider + least-privilege deploy role
- `infra/bin/app.ts` — wires the second stack, reads `githubRepo` / `oidcProviderArn` context
- `infra/package.json` — `diff`/`deploy`/`destroy` scoped to `WealthNavigator-*`
- `.github/workflows/deploy.yml` — explicit stack name on `cdk diff` and `cdk deploy`
- `buildspec.yml` — explicit stack name on `cdk deploy`
- `README.md` — CI/Deploy/tests/node/data badges with placeholder URLs

**Audit findings — two things would have failed on the first CI run**

1. **`npm run lint` was already failing.** Two stray bug-hunt probes at the repo
   root — `bug.tmp.ts` and `edge.tmp.ts`, both dated 20 Sep 14:27 — carry unused
   imports, and the lint script runs with `--max-warnings 0`:
   ```
   bug.tmp.ts   1:137  warning  'runScenario' is defined but never used
   edge.tmp.ts  25:8   warning  'UserProfile' is defined but never used
   ✖ 2 problems (0 errors, 2 warnings)   ESLint found too many warnings (maximum: 0).
   ```
   Now gitignored and lint-ignored rather than deleted (deleting files is on the
   stop list). **They are still on disk — delete them yourself if they are spent.**
2. **A second CDK stack breaks an unqualified `cdk deploy`.** Adding the deploy-role
   stack means `cdk deploy` with no stack name now errors with "Since this app
   includes more than a single stack, specify which stacks to use". Fixed in
   `deploy.yml`, `buildspec.yml` and `infra/package.json` by naming the stack.
   This also closes a real hole: the pipeline can no longer modify the role that
   grants it access.

Everything else in `ci.yml`, `deploy.yml` and `buildspec.yml` checks out. The
dependency-audit job passes today (`npm audit --audit-level=high --omit=dev` → exit 0;
two *moderate* react-router advisories are reported but do not gate, by design).

**Decisions I made without asking**
- **Did not delete `bug.tmp.ts` / `edge.tmp.ts`** — deletion is on the stop list.
  Ignoring them fixes the gate without destroying anything of yours.
- **Added `.gitattributes`.** The repo is authored on Windows and built on
  `ubuntu-latest`; without normalisation every file churns CRLF↔LF and diffs
  become unreadable. Not requested, but it is a version-control concern and T1 is
  the only moment it is cheap to do.
- **Least privilege means "can assume the CDK bootstrap roles", not a hand-written
  service policy.** `cdk deploy` executes through the bootstrap roles, which the
  bootstrap stack already scopes. Granting the GitHub role CloudFormation, S3,
  Lambda, DynamoDB and IAM permissions directly would be both broader and
  redundant. The role holds two statements and no managed policies.
- **Trust pinned to `ref:refs/heads/main` plus `environment:<stage>`,** not a
  wildcard `repo:OWNER/REPO:*`. A wildcard would let any branch — including one
  opened by a fork PR — mint deploy credentials.
- **`githubRepo` defaults to the placeholder `OWNER/REPO`** so the stack always
  synthesizes in CI and gets validated, while a deploy without the real value
  produces a role nothing can assume rather than one anything can.
- **One role per stage** (`wealth-navigator-deploy-<stage>`), so staging cannot
  deploy prod.

**Proof**
```
$ npm run lint                → LINT_EXIT=0        (was 1)
$ npm run typecheck           → TYPECHECK_EXIT=0
$ npm test                    → tests 46 / 42 / 29, fail 0   (117 total)
$ npx cdk synth               → SYNTH_EXIT=0, both stacks
$ npx cdk list                → WealthNavigator-dev
                                WealthNavigatorDeployRole-dev
$ npm audit --audit-level=high --omit=dev → AUDIT_EXIT=0
```
Generated trust policy (`-c githubRepo=piyushp69/ai-wealth-navigator`):
```yaml
Action: sts:AssumeRoleWithWebIdentity
Condition:
  StringEquals:
    token.actions.githubusercontent.com:aud: sts.amazonaws.com
  StringLike:
    token.actions.githubusercontent.com:sub:
      - repo:piyushp69/ai-wealth-navigator:ref:refs/heads/main
      - repo:piyushp69/ai-wealth-navigator:environment:dev
```

**Anything I deliberately left out**
- The remote, the push, `cdk bootstrap`, and both `cdk deploy`s — all on the stop
  list. Exact commands are in **BLOCKED** above.
- Badge URLs still say `OWNER/REPO`; they cannot be correct until the remote exists.
- No branch protection or CODEOWNERS — that is a GitHub-side setting, not code.

**Noted, not touched** (constraint 8 — outside this task)
- `scripts/` is empty. T17 decides: populate or delete.
- `git config user.email` here is `piyushpriyanshu72@gmail.com`, which is not the
  address this session is signed in with. Commits are authored with the former.

---

## T2 — Health cover rule  [done]

**Files touched**
- `packages/shared/src/types.ts` — 5 new fields on `MarketAssumptions` (additive)
- `packages/shared/src/assumptions.ts` — the values, `HEALTH_COVER_AGE_BANDS`,
  `healthCoverFloorForAge()`, `healthCoverTarget()`
- `packages/shared/src/finance/actions.ts` — rule `close-health-cover-gap`, pushed
  immediately after `close-life-cover-gap`. Rule count 14 → 15.
- `packages/shared/test/engine.test.ts` — 6 new tests
- `packages/web/src/pages/Assumptions.tsx` — a **Protection** card: 5 sliders, the
  age bands stated, and a live "cover this plan implies for you" vs "held today"
- `packages/web/src/pages/Actions.tsx` — "from 15 rule checks", plus a paragraph in
  the published ranking explanation covering the protection ordering
- `README.md`, `docs/ARCHITECTURE.md`, `docs/DEMO_SCRIPT.md` — Thirteen → Fifteen;
  ARCHITECTURE gains the need model and why it takes the higher of two rules

**The model**
```
target = max(annualIncome × healthCoverIncomeMultiple, floorForAgeBand(age))
         + dependents × healthCoverPerDependent
gap    = target − healthInsuranceCover        (no action when gap ≤ 0)
```
House view: `0.5×` income; floors 5L / 10L / 15L at age bands `<40`, `40–55`, `>55`;
3L per dependent. All five are editable per profile via `assumptionOverrides`.

Against the shipped personas:

| Persona | Age / dep / held | Target | Gap | Priority |
|---|---|---|---|---|
| Aarav | 26 / 0 / 5L | 5.70L | 0.70L | 66.5 |
| Meera | 38 / 2 / 10L | 19.68L | 9.68L | 70.4 |
| Rohan | 52 / 1 / 20L | 26.10L | 6.10L | 68.1 |
| Meera, zero cover | 38 / 2 / 0 | 19.68L | 19.68L | 74.9 (urgent) |

**Decisions I made without asking**
- **Flat scalars on `MarketAssumptions`, not a nested `healthCover` object.** The
  ledger's override machinery (`assumptionOverrides`, `isOverridden`,
  `resolveAssumptions`) is a shallow merge keyed by `keyof MarketAssumptions`. A
  nested object would be replaced wholesale by a single slider edit.
- **Age-band boundaries (40, 55) are structural, not per-profile tunables.** The
  amounts are what a user has an opinion about and those are editable; moving a
  boundary changes the shape of the model rather than its calibration. They are
  exported as `HEALTH_COVER_AGE_BANDS` and printed in the ledger so nothing is hidden.
- **The rule fires on any gap > 0**, exactly as the brief specifies — no materiality
  threshold. This is why Aarav gets a low-priority 70k action rather than nothing;
  a 5L floater on 11.4L of income is genuinely thin, and it ranks 66.5 so it sits
  near the bottom of his list where it belongs.
- **Urgency weights re-tuned mid-task after a failing test.** The first cut used
  `68 + severity×6 + dependents×1.5 + 3` clamped to 77, which made "no cover, two
  dependents" and "no cover, none" score *identically* at the ceiling — the
  dependent signal existed in the arithmetic and never reached the user. Now
  `66 + severity×4 + min(dependents,3)×1.2 + 2.5`, whose joint maximum is 76.1,
  still strictly under the life-cover rule's 78. The test that caught it is kept.
- **Impact is the gap; the emergency-fund knock-on is carried in `why`, the
  assumptions and `evidence`.** `NextBestAction.impact` is a single metric, and
  splitting a protection gap across two headline numbers would overstate it.

**Tests added (6)** — real output, `npm test`:
```
ℹ tests 52   ℹ pass 52   ℹ fail 0      (shared — was 46)
ℹ tests 42   ℹ pass 42   ℹ fail 0      (server)
ℹ tests 29   ℹ pass 29   ℹ fail 0      (web)
$ npm run lint       → LINT_EXIT=0
$ npm run typecheck  → TYPECHECK_EXIT=0
```
Total 117 → **123**. The new ones: correct gap for the under-insured persona and
the emergency-fund knock-on; adequately covered profile produces nothing; zero
cover with dependents ranks urgent and outranks both partial cover and the same
profile without dependents; health ranks immediately below life within protection
for every persona where both fire; the `max(income, floor)` model including both
band boundaries and the dependent loading; and a ledger override widening the gap.

**Anything I deliberately left out**
- `docs/API.md` is unchanged — T2 adds no endpoint or payload field. The action
  reaches clients through the existing `snapshot.actions` and the existing
  `get_next_best_actions` tool, both already documented.
- The **Protection wellness pillar still scores life cover only**. Wiring health
  cover into `scoreWellness` would change every persona's headline score and is
  not what T2 asked for.

**Noted, not touched** (constraint 8)
- **The published ranking copy overstates the waterfall, and did so before this
  task.** The Actions page says "protection and expensive debt outrank optimisation
  even when the optimisation shows a larger number". For Meera the real order is
  `fund-goal-g2` 87.1, `align-allocation` 81.8, `fund-goal-g1` 81.8, then life cover
  78 — so goals and an investing rule already outrank protection. The scores blend
  waterfall position with impact and urgency rather than enforcing strict bands. My
  added paragraph is written to be true as scored; the pre-existing sentence is not
  mine to rewrite. Worth a decision in T17: either enforce banded scores or correct
  the copy.

---

## T3 — Surface what is already built  [done]

Not quite the UI-only task the brief expected: delete-session had no endpoint, and
the Scenario Lab had no allocation control at all to attach the ladder to. Both
were built.

**Files touched**
- `packages/server/src/store/index.ts` — `deleteSession` on the `Store` interface
  and both implementations (Dynamo reads the item first: the session id alone does
  not give the partition key)
- `packages/server/src/routes/agent.ts` — `DELETE /api/agent/sessions/:sessionId`
- `packages/web/src/lib/api.ts` — `api.deleteSession`
- `packages/web/src/pages/Assistant.tsx` — conversation history
- `packages/web/src/pages/Scenarios.tsx` — server-side comparison, pin limit 3 → 6,
  allocation override via the ladder
- `packages/web/src/components/RiskLadder.tsx` (new) — the ladder, extracted
- `packages/web/src/pages/Portfolio.tsx` — rewired onto the shared component
- `packages/web/src/pages/Assumptions.tsx` — the ladder, re-priced by your edits
- `packages/web/src/styles.css` — `.session-row`, `.truncate`
- `packages/server/test/agent.test.ts` — 2 new tests
- `docs/API.md` — the DELETE endpoint, and what a stored session actually carries

**1. Chat history** — collapsible list above the chat, showing each conversation's
first question, message count and date. Clicking one reloads it *with its trace*:
every assistant turn persists its own plan, tool calls, verification and
attachments, so a reopened answer is as auditable as a live one. "New chat" clears
the session. Delete is a two-step inline confirm, optimistic, and refreshes the
list afterwards. The list also refreshes when a run finishes, so a new conversation
appears without a reload.

**2. Server-side comparison** — pinned scenarios now go through
`POST /api/plan/:id/scenarios/compare`, which scores all of them against one
baseline it builds once. Pin limit raised 3 → 6, matching the endpoint's cap.

**3. The risk ladder** — now on three screens. On Assumptions it answers "what do my
edits do to *every* portfolio, not just mine". In the Scenario Lab it is the
allocation-override control.

**Decisions I made without asking**
- **Extracted `RiskLadder` into a component rather than copying the table.** The
  task puts the same 50-line table on three screens; three copies is exactly the
  "second implementation to drift" problem constraint 1 exists to prevent. This
  touches Portfolio, which T3 did not name — the alternative was worse.
- **The live scenario row stays local; only pinned rows go to the server.** Pinned
  rows do not depend on the live levers, so the request fires when the pinned set
  or the saved profile changes, not on every slider settle. Dragging stays instant
  and the network is not hammered.
- **Server comparison falls back to the browser engine on failure**, with a visible
  note. Constraint 2: the feature has to work offline and with no credentials. The
  numbers are identical either way — the only thing lost is the shared baseline.
- **The Assumptions ladder refreshes on `saveState === 'saved'`, not on
  `profile.updatedAt`.** `updatedAt` bumps on every keystroke while the save is
  still debounced, so keying on it would re-fetch the *pre-edit* figures and show
  them as if they were the result. The card says the rows follow each save.
- **The Scenario Lab allocation control is the ladder, not six weight sliders.**
  The engine has always accepted `levers.allocation` and nothing in the UI could
  set it. The real question is "what if I moved a risk level", and the ladder is
  the only place that trade is priced. Selection is matched by comparing weights,
  so a preset that sets an allocation directly still highlights the right row.
- **Delete is idempotent (204 on an unknown id).** The client deletes optimistically;
  a 404 on retry would report failure for work that already succeeded.
- **No `window.confirm`** for delete — a two-step inline confirm instead. A modal
  blocks the page and is untestable in a headless browser, which T16 will need.

**Tests added (2)** — real output:
```
ℹ tests 52   ℹ pass 52   ℹ fail 0      (shared)
ℹ tests 44   ℹ pass 44   ℹ fail 0      (server — was 42)
ℹ tests 29   ℹ pass 29   ℹ fail 0      (web)
$ npm run lint       → LINT_EXIT=0
$ npm run typecheck  → TYPECHECK_EXIT=0
$ npm run build      → BUILD_EXIT=0   (✓ built in 2.41s)
```
Total **125**. A stored conversation carries a usable trace (plan, tool calls with
finite timings, verification) — this is what makes reopening one honest rather than
decorative; and a conversation can be deleted, disappears from the list, 404s on
read, and a second delete still returns 204.

**Anything I deliberately left out**
- **No test drives the new UI.** The web suite is SSR smoke renders only, so nothing
  can click "New chat" or pin six scenarios. The endpoints underneath are covered;
  the interactions are not. That gap is T16's job and I have not pre-empted it.
- Restored tool calls show name, label and timing but no summary, because summaries
  were never persisted. Persisting them would change the stored session shape and
  grow every item — worth doing in T7 when snapshots arrive, not silently here.

### T2 correction — the wellness pillar already scored health cover

My T2 note said "the Protection wellness pillar still scores life cover only".
That was wrong: `scoreWellness` has always scored health cover as 20% of the
Protection pillar — using its own hardcoded `annualIncome * 0.5`, with no age
floor, no dependent loading and no way for the ledger to reach it. Raising
`healthCoverIncomeMultiple` moved the action and left the score that grades it
untouched: two models of the same thing, which is precisely what constraint 1
exists to prevent.

`scoreWellness` now calls `healthCoverTarget()`, and a test asserts that raising
the multiple lowers the Protection score, so the two cannot drift apart again.
Persona wellness scores shift by a point or two where cover was thin; no test
encoded an exact total. Shared tests 52 → 53.

---

## T4 — The "value created" hero metric  [done]

**Files touched**
- `packages/shared/src/finance/mutations.ts` (new) — the four machine-applicable
  mutations, lifted out of `Actions.tsx`
- `packages/shared/src/impact.ts` (new) — `computeActionImpact`
- `packages/shared/src/index.ts` — exports both
- `packages/web/src/pages/Actions.tsx` — Apply now calls the shared applier
- `packages/web/src/components/ImpactHero.tsx` (new) — the dashboard card
- `packages/web/src/pages/Dashboard.tsx` — hero above the wellness score
- `packages/web/src/lib/api.ts` — `api.impact`
- `packages/server/src/routes/planning.ts` — `GET /api/plan/:id/impact?top=`
- `packages/server/src/agent/tools.ts` — `estimate_action_impact`
- `packages/shared/test/engine.test.ts` — 7 new tests
- `docs/API.md`, `docs/ARCHITECTURE.md`, `docs/DEMO_SCRIPT.md`

**The headline was overstated on the first working version, and the fix is the
most important thing in this task.** The first run reported, for Aarav:

```
retirement funded 41% -> 459%     applied: Add 73.6k/month to "Retirement"
```

against a profile whose monthly surplus is **−₹1,200**. The `fund-goal-*` rules
mutate a contribution by the whole monthly gap whether or not the surplus covers
it, and the wellness score *rises* when contributions rise, because the savings
rate does — so the plan nobody could run was graded higher for saying so. The
same bug sat behind Rohan's "Add 7.25 L/month".

An action is now counted only if it leaves the surplus non-negative, or at least
no worse than it already was. Excluded ones appear in `notModelled` carrying the
arithmetic: *"it would need about 73,610 a month against a surplus of −1,200."*
The honest headlines:

| Persona | Wellness | Retirement funded | Emergency cover | Counted / excluded |
|---|---|---|---|---|
| Aarav | 43 D → 57 C | 41% → 41% | 1.3m → 6.0m | 2 of 10 |
| Meera | 60 C → 62 C | 60% → 60% | 4.5m → 6.0m | 3 of 12 |
| Rohan | 72 B → 76 B | 89% → 89% | 8.3m → 8.3m | 2 of 10 |

**Decisions I made without asking**
- **Extracted the mutation appliers into `@wealth/shared`.** The brief says to use
  "the existing mutation appliers" — they lived inside a React component, so
  there was nothing shared to use. Both the Apply button and the impact figure now
  call the same code; if they had diverged, the platform would promise one outcome
  and deliver another.
- **Rebalance holdings get deterministic ids** (`h-<class>-rebalanced`, previously
  `h-<class>-${Date.now()}`). Impact applies the mutations repeatedly and has to
  produce a byte-identical profile each time; a timestamped id made the whole
  calculation non-reproducible.
- **`estimate_action_impact` is a new 13th tool, not a fact bolted onto
  `get_next_best_actions`.** The brief says "expose as an agent tool fact" and its
  T5 note assumes the count stays at 12. Folding it in would make the single most
  commonly called tool run three cumulative snapshots and three 1,500-path
  simulations on every question. **Tool count is now 13, so T5 takes it to 14.**
- **`top` counts applicable, affordable actions**, so the walk continues down the
  ranked list until it finds that many, rather than stopping at the first three
  and reporting two.
- **The impact call is server-side, refetched on save.** Three cumulative
  snapshots plus three seeded simulations is not work for the render thread.
- **Negative marginals are shown, not hidden.** Meera's `align-allocation` scores
  −1 wellness and −₹30 L on the median corpus: raising equity raises the expected
  return *and* the variance drag, which lowers the median. An assumption line on
  the card explains it. Suppressing it would be the same dishonesty as the 459%.

**Tests added (7)** — real output:
```
ℹ tests 60   ℹ pass 60   ℹ fail 0      (shared — was 53)
ℹ tests 44   ℹ pass 44   ℹ fail 0      (server)
ℹ tests 29   ℹ pass 29   ℹ fail 0      (web)
$ npm run lint       → LINT=0
$ npm run typecheck  → clean
$ npm run build      → BUILD=0
```
Total **133**. One per persona asserting the metrics are finite and that the
marginal deltas sum to the headline change (the claim the breakdown makes);
reproducibility including "does not mutate its input"; the affordability gate
across all three personas; an already-optimised plan settling to a no-op without
dividing by zero; and a retired profile (zero years to accumulate) not dividing
by zero in the simulation.

**Anything I deliberately left out**
- **The Apply button still applies the full, unaffordable contribution.** The
  impact figure now refuses to count it, but clicking Apply on the Actions page
  still writes a plan the user cannot fund. Fixing that changes existing
  behaviour users may have relied on, and **T9 rebuilds this path deliberately**
  (proposal + before/after diff + explicit approval). It belongs there, not
  smuggled in here. Until then the two disagree, and the impact card is the
  conservative one.
- No UI test for the hero card — same SSR-only limitation as T3. The endpoint and
  the engine beneath it are covered.

---

## Groq — a third reasoning provider  [done]

Out of queue: requested directly, not from `IMPLEMENTATION.md`. Slots beside
`anthropic` and `bedrock`; the execution order is otherwise untouched and T5 is
still the next task.

**Files touched**
- `packages/server/src/agent/groq.ts` *(new)* — the whole Anthropic↔OpenAI
  translation layer, plus the SSE reader and the stream accumulator.
- `packages/server/src/agent/llm.ts` — `GroqClient`, `GroqApiError`, error
  narrowing by HTTP status, and the `getLlm()` branch.
- `packages/server/src/config.ts` — `groq` provider, `groqModel`,
  `groqBaseUrl`, `groqMaxTokens`, and `activeModel()`.
- `packages/server/src/app.ts`, `routes/agent.ts`, `index.ts` — report the model
  actually answering.
- `packages/shared/src/types.ts`, `packages/web/src/lib/api.ts`,
  `components/Shell.tsx`, `pages/Assistant.tsx` — `groq` in the engine union and
  its badge.
- `packages/server/test/groq.test.ts` *(new)*, `packages/server/package.json`,
  `.env.example`, `docs/API.md`, `docs/DEPLOYMENT.md`.

**Decisions I made without asking**
- **No new dependency.** Groq's endpoint is OpenAI-compatible JSON, so it is
  reached with `fetch`. `groq-sdk` would have shipped a package to the Lambda
  bundle to do what 40 lines already do, and that needs asking. Bundle is
  unchanged at 271 KB.
- **The translation layer is its own module.** `llm.ts` keeps the clients;
  `groq.ts` holds the mapping, because the mapping is the part that rots
  silently and it is the part worth testing without a network.
- **The orchestrator was not touched.** `GroqClient` returns a real
  `Anthropic.Message`, so provider branching stays out of the agent loop.
- **`activeModel()`.** `/api/health` and `/api/agent/capabilities` returned
  `config.model` for any non-deterministic provider, so Groq mode would have
  badged the UI `claude-opus-5` while gpt-oss did the writing. A badge naming
  the wrong model is worse than no badge.
- **Anthropic wins when both keys are set.** `GROQ_API_KEY` alone selects Groq;
  `LLM_PROVIDER=groq` forces it either way.
- **`reasoning_effort` is sent by allowlist, not denylist.** `groq/compound`
  rejects it with a 400. An unknown model should lose effort control, not the
  whole request.
- **`GROQ_MAX_TOKENS` defaults to 1500, clamping the orchestrator's 8000.** Groq
  reserves the whole of `max_tokens` against a per-minute allowance, so passing
  8000 through spent a free account's entire minute on one call and every
  request 429'd before the model saw it. Measured: the same call went from
  ~11,000 tokens requested to 2,984.
- **`npm run dev` now loads `.env`** via `--env-file-if-exists`. Nothing read
  that file before, so `.env.example` was aspirational and a key set there did
  nothing. Deliberately not added to `npm test`, which must stay credential-free.
- **The chain of thought is dropped, not streamed.** gpt-oss streams `reasoning`
  in a sibling field to `content`. Forwarding it would have printed the model's
  private reasoning into the user's answer.

**Tests added (17)** — real output:
```
ℹ tests 74   ℹ pass 74   ℹ fail 0      (shared)
ℹ tests 65   ℹ pass 65   ℹ fail 0      (server — was 48)
ℹ tests 29   ℹ pass 29   ℹ fail 0      (web)
$ npm run lint       → exit 0, zero warnings
$ npm run typecheck  → clean
$ npm run build      → exit 0
```
Total **168**. They cover the two directions of the mapping, the tool-call id
round trip, argument fragments split across stream chunks, SSE events split
across network chunks, the reasoning field never reaching the caller, the
`reasoning_effort` allowlist and the token clamp.

Verified live against `api.groq.com`, not just in tests:
```
engine   : groq
tools    : get_financial_snapshot, run_monte_carlo
grounding: 4/4 claims grounded
```

**Anything I deliberately left out**
- **Not committed.** The working tree already holds the unfinished T5 optimiser,
  and `packages/shared/src/types.ts` is modified by both. Committing would have
  mixed two tasks into one commit against the one-task-per-branch rule, so the
  Groq work is staged in the tree for you to split as you prefer.
- **A free Groq account cannot finish most multi-step runs.** Each step costs
  ~3,000 tokens with all 14 tool schemas attached, against an 8,000/minute
  allowance — about two steps. Beyond that the run falls back to the
  deterministic engine and the answer still arrives with identical numbers.
  Fixing it properly means either a paid tier or sending Groq a reduced tool
  set, and trimming the agent's tools is a product decision, not a wiring one.
- **`ENGINE_LABEL` in `Shell.tsx` and `ENGINE_TEXT` in `Assistant.tsx` are now
  two lists of the same four engines.** The duplication predates this task; I
  extended both rather than extracting a shared map, per the no-drive-by-refactor
  rule. Worth collapsing when something else touches those files.
- **No retry on a 429.** Groq returns a `retry-after` hint the client ignores,
  falling back instead. A retry would be a latency decision affecting every
  provider, which belongs with T10's rate limiting.
- **`npm test` still inherits a real `GROQ_API_KEY`/`ANTHROPIC_API_KEY` from the
  shell if one is exported**, which would flip the suite off the deterministic
  path. Pre-existing, not introduced here.

---

## Fix — a recoverable agent error killed the SSE stream  [done]

Found by using the Assistant in the browser: a question answered with
"The connection to the assistant was interrupted." right after the
"Rank the highest-impact actions" step, with no answer. The server log showed
the opposite — `agent run complete ... intent: actions, ms: 3864`. The run
succeeded; only the client gave up.

**Cause.** `error` is not usable as an SSE event name. EventSource dispatches a
server-sent frame named `error` as an `error` event *on the EventSource object*
— the same event a dropped connection fires. `streamAgent`'s `onerror` cannot
tell the two apart, so it treated a recoverable agent notice as a dead socket,
closed the stream, and discarded the `final` answer arriving milliseconds later.

Reproduced deterministically by pointing `GROQ_BASE_URL` at a dead port:
```
before: run_started plan error      plan tool_call ... verification final thought done
after:  run_started plan agent_error plan tool_call ... verification final thought done
```
Both runs complete server-side; only the first one is thrown away by the browser.

**Pre-existing, exposed by Groq.** The orchestrator has always emitted
`type: 'error'` when the model path fails. It had never been reachable in
practice: with no key the agent starts deterministic and never errors, and with
a working key it does not fail mid-run. Groq's free tier 429s partway through a
multi-step run, which is the first thing that routinely trips it.

**Files touched**
- `packages/server/src/lib/sse.ts` — `WIRE_NAMES` maps `error` to `agent_error`
  on the wire only.
- `packages/web/src/lib/api.ts` — listens for `agent_error`.
- `packages/server/test/sse.test.ts` *(new)*, `packages/server/package.json`.

**Decision I made without asking.** Only the *wire* name changes. The payload
still carries `type: 'error'`, so `AgentEvent` in `@wealth/shared` is untouched
and every consumer that switches on `event.type` — including
`Assistant.tsx:237` — keeps working unchanged. Renaming the shared union member
would have been a breaking change to the shared API for no benefit.

**Tests added (2)** — real output:
```
ℹ tests 74   ℹ pass 74   ℹ fail 0      (shared)
ℹ tests 67   ℹ pass 67   ℹ fail 0      (server — was 65)
ℹ tests 29   ℹ pass 29   ℹ fail 0      (web)
$ npm run lint  → exit 0    $ npm run build → exit 0
```
Total **170**. The guard asserts the reserved name never reaches the wire, that
the agent error still arrives, and that the payload keeps its own discriminant.

**Anything I deliberately left out**
- **No retry on the underlying 429.** The stream now survives it and the answer
  still arrives from the deterministic engine, but on a free Groq account a
  multi-step run will still often be narrated by the fallback rather than the
  model. That is the quota, not the framing.
- **`npm run dev` had a second bug I introduced and fixed here:** the script was
  `tsx --env-file-if-exists=... watch src/index.ts`, and tsx reads the first
  non-flag argument as the entry file, so it tried to run a file named `watch`
  and the API never started. The subcommand must come first.

---

## Fix — "rate limited, retrying shortly" was a lie, and nothing retried  [done]

Reported from the browser: two questions answer fine, then a third ends with
"The reasoning service is rate limited. Retrying shortly." Two separate faults
behind one message.

**Fault 1 — the copy promised something that never happened.** Nothing retried.
`describeLlmError` is only reached after the orchestrator has given up, on its
way into the deterministic fallback. The message is now what actually occurs:
"…Answering with the deterministic engine instead." Fixed in both places it
appears, so the Anthropic path stops making the same false promise.

**Fault 2 — the Groq client had no retry at all.** `new Anthropic({ maxRetries: 2 })`
gives the other two providers two automatic retries from the SDK; the
fetch-based Groq path I added had none, making it the least resilient of the
three. It now retries twice, honouring the wait Groq states in the 429 body
("Please try again in 1.38s") and the `retry-after` header, preferring the hint
over backoff because the allowance refills continuously rather than on a fixed
boundary.

Retrying inside `post()` is deliberate: it runs before the response body is
touched, so no tokens have streamed and a retry cannot duplicate text.

**The ceiling was wrong on the first attempt.** I capped a single wait at 8s.
Measured against the real account, a mid-run step is told to wait 9-10s, so the
cap rejected exactly the retries worth taking - two of three questions still
fell back. Replaced with a cumulative budget across the call
(`GROQ_RETRY_BUDGET_MS`, default 12s): what matters to someone watching a
spinner is total delay, and a per-attempt cap bounds the wrong thing.

Three consecutive questions, before and after:
```
before:  groq (8s) | deterministic | deterministic     retryInMs: null, null
after:   groq (8s) | groq (24s)    | deterministic (1s)  retryInMs: 10000, 8000
```

**Files touched**
- `packages/server/src/agent/groq.ts` — `retryDelayMs`, `hintedDelayMs`, `sleep`.
- `packages/server/src/agent/llm.ts` — retry loop in `GroqClient.post()`,
  honest copy, `GROQ_MAX_RETRIES`.
- `packages/server/src/config.ts` — `groqRetryBudgetMs`.
- `packages/server/test/groq.test.ts`, `.env.example`, `docs/DEPLOYMENT.md`.

**Tests added (8)** — real output:
```
ℹ tests 74   ℹ pass 74   ℹ fail 0      (shared)
ℹ tests 75   ℹ pass 75   ℹ fail 0      (server — was 67)
ℹ tests 29   ℹ pass 29   ℹ fail 0      (web)
$ npm run lint → exit 0   $ npm run typecheck → clean   $ npm run build → exit 0
```
Total **178**. They pin the hint parser against a verbatim Groq 429 body, the
header winning over the message, the cumulative budget, the bound on attempts,
and which statuses are worth retrying at all.

**Anything I deliberately left out**
- **The budget bounds one call, not one run.** The agent makes a request per
  step, so each gets its own budget — which is why the rescued question took
  24s across two waits. Making it per-run means threading state through the
  orchestrator, which this task did not ask for.
- **The third question still falls back, and always will.** Three questions in
  40s is ~10,000 tokens against an 8,000/minute allowance. Retrying cannot
  manufacture quota; it only stops the platform giving up on waits it could
  afford. The structural fixes remain a paid tier or fewer tool schemas per
  step, and the latter is a product decision.
- **No jitter on the backoff.** One client, no thundering herd to avoid.

---

## Fix — the engine read rupee constants against a dollar profile  [done]

Reported as "the conversion rate is not correct" after switching INR to USD.
The rate and `convertCurrency` were both fine. What was wrong was that four
assumptions are *amounts of rupees*, and nothing converted them, so a converted
profile was compared against unconverted constants.

**Measured, all three personas, before:**
```
aarav   wellness INR=43 USD=39    Protection INR=28 USD=11
meera   wellness INR=60 USD=57    Protection INR=56 USD=46
rohan   wellness INR=72 USD=68    Protection INR=75 USD=60
```
Only Protection moved, in every persona. `healthCoverTarget` is
`max(income x multiple, floorForAge) + dependents x perDependent`. The income
term scales with the profile's currency; the floor and the per-dependent
loading are fixed rupee amounts. In USD the income term collapses by 83x, the
rupee floor then dominates as though it were dollars, and the target becomes
83x too large - aarav's ₹5,00,000 cover, correctly converted to $6,024, was
measured against a floor of "$500,000".

**After:**
```
aarav   wellness 43 = 43    meera 60 = 60    rohan 72 = 72    Protection identical
```

**Fix.** `MONETARY_ASSUMPTION_KEYS` names the four assumptions that are money
rather than rates, and `ASSUMPTION_BASE_CURRENCY` records that the house view
states them in INR. `resolveAssumptions` - the single chokepoint every consumer
already goes through - converts the defaults into the profile's currency, which
fixed the engine, the optimiser, the agent tools and the server at once.

**Decisions I made without asking**
- **Overrides are stored in the profile's currency, defaults in INR.** The
  ledger already edits these in the displayed currency, so an override is
  layered on *after* conversion and left alone; converting it again would
  divide the user's own number by 83. `switchCurrency` now moves the monetary
  overrides with every other amount, which keeps the two consistent.
- **The conversion lives in `engine.ts`, not `assumptions.ts`.** `format.ts`
  already imports `assumptions.ts`, so putting it there would have made a cycle
  or forced a second copy of the conversion - the one thing this repo is most
  careful not to have.
- **The ledger's slider bounds are now currency-aware.** They were written in
  rupees (`max 1_000_000`, `step 50_000`). Against a correctly-converted $3,614
  per-dependent loading those are 83x too coarse to express the value, so
  touching the slider would have snapped the assumption to something absurd -
  turning a display bug into a data-loss bug. Bounds convert and round to one
  significant figure, which is the identity in INR.

**Files touched**
- `packages/shared/src/assumptions.ts` — `MONETARY_ASSUMPTION_KEYS`,
  `ASSUMPTION_BASE_CURRENCY`.
- `packages/shared/src/finance/engine.ts` — `assumptionsInCurrency`, and
  `resolveAssumptions` converts the house view.
- `packages/web/src/state/ProfileContext.tsx` — `switchCurrency` moves monetary
  overrides.
- `packages/web/src/pages/Assumptions.tsx` — currency-aware slider bounds.
- `packages/shared/test/currency.test.ts` *(new)*, `packages/shared/package.json`.

**Tests added (5)** — real output:
```
ℹ tests 79   ℹ pass 79   ℹ fail 0      (shared — was 74)
ℹ tests 75   ℹ pass 75   ℹ fail 0      (server)
ℹ tests 29   ℹ pass 29   ℹ fail 0      (web)
$ npm run lint → exit 0   $ npm run typecheck → clean   $ npm run build → exit 0
```
Total **183**. The load-bearing one asserts every persona scores identically in
both currencies, which is what actually failed. One asserts net worth still
differs by the rate, so invariance cannot be faked by ignoring currency; one
pins that rates and multiples are *not* converted, which would be the opposite
mistake; one pins that an override is read in the currency it was typed in.

Verified against the running app, not only in tests:
```
INR  wellness 60 | protection 56 | net worth 4447500
USD  wellness 60 | protection 56 | net worth 53585     (4447500 / 83 = 53584)
```

**Anything I deliberately left out**
- **±1 point of rounding drift survives, in one pillar of one persona.**
  `switchCurrency` rounds every amount to whole units, so aarav's Cashflow
  pillar reads 67 in INR and 68 in USD. Re-measured with an unrounded
  conversion it is 67 in both, which is how I know it is rounding and not
  another stray constant. Removing it means storing fractional currency, which
  is worse to read and to edit.
- **`USD_INR_RATE = 83` is still a fixed illustrative rate**, and is labelled as
  one in the UI and in `assumptions.ts`. Nothing here makes it a live rate, and
  if the complaint was about the *rate* rather than the arithmetic, that is a
  live FX feed and a different task.
- **`engine.ts:462`'s `levers: { lumpSum: 300000 }` preset is still rupees.**
  It is a demo scenario input rather than an engine constant, so it does not
  corrupt a score, but a USD user running that preset gets a $300,000 lump sum.
  Noted rather than fixed, per the no-drive-by rule.

---

## Simplification brief — Phase 1, tasks 1-2  [done]

### Task 1 — INR only
Removed the second display currency rather than keeping it correct. Files:
`shared/{types,assumptions,format}.ts`, `shared/finance/engine.ts`,
`web/{state/ProfileContext,components/Shell,pages/Onboarding,pages/Assumptions}.tsx`,
`server/routes/profiles.ts`.

**Decision I made without asking.** `Currency` is narrowed to the single member
`'INR'` rather than deleted. Deleting it meant a mechanical edit across 30 files
that all pass `profile.currency` to a formatter; narrowing it instead makes the
*compiler* prove no second currency can reach any of them, which a deleted
parameter would not. `profile.currency` and the formatter parameter survive as
provably-constant, and the Zod schema is now `z.literal('INR')` so a stray USD
payload is a 400 rather than a silent accept.

Gone: `USD_INR_RATE`, `CURRENCY_META`, `convertCurrency`, `switchCurrency`,
`MONETARY_ASSUMPTION_KEYS`, `ASSUMPTION_BASE_CURRENCY`, `assumptionsInCurrency`,
the K/M/B formatter, the shell and onboarding toggles, and the currency-scaled
ledger slider bounds. `resolveAssumptions` is back to a plain override merge.

This supersedes A10.7 — that work made the engine correct across two currencies;
with one currency it was dead weight, which is what the brief says.

`shared/test/currency.test.ts` deleted, replaced by `shared/test/inr.test.ts`
(4 tests): lakh/crore formatting with an explicit assertion that no K/M/B scale
survives, assumptions returned unrestated, a ledger override round-tripping
byte-for-byte, and every persona being INR.

### Task 2 — merged rules, 15 -> 12
- `align-allocation` + `reduce-concentration` + `rebalance-portfolio` ->
  **`rebalance-portfolio`**. All three said "your portfolio is not the shape you
  agreed to", which is one decision and one trip to the broker.
- `deploy-idle-cash` + `automate-surplus` -> **`deploy-surplus`**.

12, not the ~10-11 the brief estimated: the remaining ten do not overlap without
losing a distinct decision, and I would rather report the real number.

**Decisions I made without asking**
- **A merged rule scores `Math.max` of its parts, never an average**, so
  consolidating can never bury a signal that used to surface on its own. There
  is a test for exactly this.
- **Every signal still reports its own reason, steps, assumptions and
  evidence** - the merge removes duplicate *actions*, not information.
- **`deploy-surplus` projects both halves over one horizon.** They were
  separately projected over 10 years and time-to-retirement; adding those two
  figures into one headline would have been meaningless.
- **`apply` is conditional on the merged rebalance rule**: drift has an exact
  set of trades (`rebalance_to_target`), the other two signals are a change of
  target (`set_allocation`).
- Dashboard "Do this next" now shows the top 3 with a "See all N actions" link;
  /actions still lists everything.

**Tests** — real output:
```
ℹ tests 83   ℹ pass 83   ℹ fail 0      (shared — was 79)
ℹ tests 75   ℹ pass 75   ℹ fail 0      (server)
ℹ tests 29   ℹ pass 29   ℹ fail 0      (web)
$ npm run lint → exit 0   $ npm run typecheck → clean   $ npm run build → exit 0
```
187 total. New `shared/test/actions-merged.test.ts` (5 tests) asserts the retired
ids are gone from every persona, that concentration still reaches the user
through the merged rule, that the merged score never drops below its most urgent
part, and that both halves of `deploy-surplus` share one horizon.

One existing assertion changed: `api.test.ts` looked for `deploy-idle-cash`,
which is now `deploy-surplus`. That is the rename, not a weakened expectation.

Copy reconciled in README, `docs/API.md`, `docs/DEMO_SCRIPT.md`, `Actions.tsx`,
`mutations.ts`, `impact.ts` and `FEATURES.txt` (count and waterfall list).
Four of twelve rules still carry a machine-applicable mutation.

### Not started
Tasks 3-15 of that brief.

---

## Groq rate limiting — a single question no longer exhausts a free minute  [done]

**The report:** every question answered, but with "The reasoning service is rate
limited. Answering with the deterministic engine instead." above the answer.

**What was actually happening.** Groq returned 429 part-way through every run:

```
Rate limit reached for model `openai/gpt-oss-120b` ... service tier `on_demand`
on tokens per minute (TPM): Limit 8000, Used 7963, Requested 3043.
Please try again in 22.545s
```

One question cost roughly 10,300 tokens against an 8,000-token minute, so it ran
its own allowance out around the third call and fell back mid-run. Measured
against Groq's tokeniser, the fourteen tool schemas are 1,641 prompt tokens and
were re-sent on every step — about 4,900 of the minute spent restating tools the
plan was never going to use. The rest went on chain of thought, billed as
completion, at `reasoning_effort: 'high'` on every turn including the opening
one, whose only decision the system prompt had already made.

**The `max_tokens` theory in the old comments was wrong.** `config.ts` and
`.env.example` both said Groq reserves `max_tokens` against the allowance, and
`GROQ_MAX_TOKENS=1500` existed to stop that. It does not: a request carrying
`max_tokens: 4000` was admitted against this account with 927 tokens left in the
minute, and cost 151. Metering is prompt plus completion actually written. The
clamp is still worth keeping — it bounds a runaway chain of thought — but it
buys no headroom, so both comments now say what is true.

Files touched:
- `packages/server/src/agent/tools.ts` — `toolSchemas(only?)` narrows to named
  tools; unknown names ignored, so a plan containing `synthesize` can be passed
  straight in.
- `packages/server/src/agent/orchestrator.ts` — `offeredTools(plan, scope)`;
  opening turn drops to `effort: 'low'`, every later turn keeps `'high'`.
- `packages/server/src/config.ts` — `agentToolScope: 'plan' | 'all'`
  (`AGENT_TOOL_SCOPE`), defaulting to `plan` on Groq and `all` elsewhere.
- `packages/server/src/agent/llm.ts` — debug-level per-call token metering.
- `packages/server/test/agent.test.ts`, `.env.example`.

Decisions I made without asking:
- **Narrowing is config, not a provider check in the orchestrator.** Only Groq
  is metered tightly enough for the schemas to be what runs it out. Putting the
  provider default in `config.ts` keeps the orchestrator free of provider
  branching, which is the property the module comment claims.
- **`get_financial_snapshot` and `search_knowledge` are offered whatever the
  plan says.** Rule 2 of the system prompt obliges a position read, and
  grounding an explanation is always in bounds; neither may depend on the
  router's guess.
- **Low effort on the opening turn only.** A first attempt keyed on the planned
  tool count also caught the answering turn — the model finishes before the plan
  does, so it narrated at low effort and skipped the Monte Carlo step. Run cost
  4,638 but the answer was visibly thinner. Step 1 is the rule that pays without
  costing anything: 29 completion tokens there versus 548.
- **`offeredTools` takes the scope as a parameter.** Tests run in deterministic
  mode, where the default is `all`; without the parameter the narrowing path is
  untestable.

Measured, one question end to end (`groq call metered`, debug):

```
before:  4 calls   prompt 5628   completion 2673   TOTAL 8301  (429, fell back)
after:   3 calls   prompt 4089   completion 1474   TOTAL 5563  (no fallback)
```

Tests added (3) — real output:
```
ℹ tests 83   ℹ pass 83   ℹ fail 0      (shared)
ℹ tests 78   ℹ pass 78   ℹ fail 0      (server — was 75)
ℹ tests 29   ℹ pass 29   ℹ fail 0      (web)
$ npm run lint → exit 0    $ npm run typecheck → clean
```
190 total. `toolSchemas` narrowing and unknown-name handling; every tool a plan
names exists; for all ten intents the offered set covers the plan, keeps both
escape hatches, stays at most half the catalogue, and still returns everything
under `'all'`. The intent list is a `Record<Intent, true>`, so adding an intent
fails the compile until its plan has been checked.

Anything I deliberately left out:
- **Two questions inside the same minute still fall back**, and no code change
  fixes it: a grounded run costs 5,500-7,000 tokens and the allowance is 8,000.
  Every tool-capable model on this account is capped at 8,000 TPM — checked via
  `x-ratelimit-limit-tokens` on `gpt-oss-120b`, `gpt-oss-20b` and `qwen3.8-27b`.
  `groq/compound-mini` reports 70,000 TPM but answers custom tools with
  `400 "tool calling is not supported with this model"`. The remedies are the
  Dev tier, or `GROQ_RETRY_BUDGET_MS=30000` to wait the ~23s out instead of
  falling back.
- The SSE stream emits one event with no `type` (it shows up as `undefined` when
  counting event types). Predates this change; not investigated.
- `GROQ_MAX_TOKENS` left at 1500. Only its rationale was wrong, not its value.

---

## Onboarding number fields keep a leading 0 — and the interest rate cannot take a decimal  [done]

**The report:** in "Enter my own numbers" every field starts at 0, and typing into
it leaves the 0 in place.

**Reproduced in the running app before touching anything** (Chrome, typing as a
user does, then reading the input's DOM value):

```
dependents     typed "2"      -> "02"
take-home pay  typed "85000"  -> "085000"   (the preview still said ₹85.0k)
interest rate  typed "8.5"    -> "8.1"      (stored 8.1%, not 8.5%)
```

**Why.** A controlled `<input type="number">` re-derives its text from the
stored number. React deliberately leaves the DOM alone when the text already
parses to the controlled value, so "085000" stays on screen because it *is*
85000 - the stored number was right, only the display kept the zero. The
interest rate is the same mechanism made worse by `toFixed(1)`: the text is
rewritten after every keystroke, so "8" became "8.0", the "5" landed after that
zero, and 8.05 rounded to 8.1. The user could not enter 8.5% at all.

Files touched:
- `packages/web/src/components/ui.tsx` — `NumberInput`: zero renders as an
  empty field with a "0" placeholder; the field keeps its own copy of the typed
  text and only the parsed number leaves it; leading zeros dropped as typed
  (`withoutLeadingZeros`). `MoneyInput` now renders through it.
- `packages/web/src/pages/Onboarding.tsx` — dependents, pay rise, interest
  rate and goal step-up moved to `NumberInput`; `asPercent` for the three
  percentage fields.
- `packages/web/test/render.test.tsx`.

Decisions I made without asking:
- **Fixed `MoneyInput` itself**, so the 26 money fields on Goals, Portfolio and
  Profile get the fix too - it is the same component with the same bug, and
  leaving it half-fixed would have meant two behaviours for one control.
- **Values from outside resync during render, not in an effect** - React's
  documented pattern for adjusting state when a prop changes, and it never
  paints stale text. Verified in the browser: switching goals on the Goals page
  refreshes the same mounted inputs (and back again), and "Apply this
  allocation" updates the open goal's contribution from 12000 to 31000.
- **Percentages show two decimals (`asPercent`) rather than `Math.round`.**
  Once a decimal can actually be typed, rounding the display to whole numbers
  would show 9 while the plan uses 8.5. The interest rate now shows `10`
  rather than `10.0` for a round number.
- **Kept `type="number"`**, so the spinner, arrow-key stepping and numeric
  keyboard on mobile are unchanged.

After the fix, same steps in the same browser:

```
dependents     typed "2"      -> "2"
take-home pay  typed "85000"  -> "85000"
interest rate  typed "8.5"    -> "8.5"
```

Tests added (3) — real output:
```
ℹ tests 83   ℹ pass 83   ℹ fail 0      (shared)
ℹ tests 78   ℹ pass 78   ℹ fail 0      (server)
ℹ tests 32   ℹ pass 32   ℹ fail 0      (web — was 29)
$ npm run lint → exit 0    $ npm run typecheck → clean    $ npm run build → built
```
193 total. A zero `NumberInput` and a zero `MoneyInput` render `value=""` with
`placeholder="0"` (both fail on the old code, which rendered `value="0"`);
`withoutLeadingZeros` turns "085000" into "85000" and "-05" into "-5" but
leaves "0", "0.5" and "8.05" alone. Typing itself needs a DOM, which this suite
does not have - that part was verified in Chrome, above.

Anything I deliberately left out:
- **Age, retirement age and goal target year** have a different bug in the same
  form: they fall back to a default when emptied (`|| 30`, `|| 60`, `|| 2040`),
  so backspacing out the age refills "30" and the next keystroke appends
  ("304"). Not a zero-placeholder problem, and fixing it means deciding when an
  empty required field gets validated - untouched.
- **Raw number inputs outside onboarding still use the old pattern:**
  Goals — target year, step-up (`Math.round`), inflation override
  (`toFixed(1)`, so the same can't-type-a-decimal bug as the interest rate);
  Portfolio — expense ratio and interest rate (`toFixed(2)`); Profile — age,
  retirement age, dependents (the same "02" bug) and pay rise. Each is a
  one-line move to `NumberInput`.

---

## Onboarding pre-filled age 30 and retirement age 60  [done]

**The report:** in "Enter my own numbers", age and target retirement age were
already filled in.

They came from `emptyProfile` (30 / 60), which the wizard used as its starting
draft. That put two numbers into the plan the user never chose - retirement age
drives the horizon, the risk capacity score and every retirement projection.

Files touched:
- `packages/web/src/pages/Onboarding.tsx` — the draft starts both ages at 0
  ("not entered yet"), both fields use `NumberInput` with no placeholder, and
  `checkAges` decides Continue and the warnings.
- `packages/web/test/render.test.tsx`.

Decisions I made without asking:
- **Changed the wizard's draft, not `emptyProfile`.** The server's
  `POST /profiles` without a persona builds from `emptyProfile`, and that
  profile has to project; changing a shared export's defaults would also have
  been a behaviour change to the `@wealth/shared` API.
- **Blank is unfinished, not wrong.** An empty age holds Continue back with no
  warning, so a fresh form never opens in red. Warnings appear only for values
  actually entered: age outside 16-100 (the bounds the input already declared)
  and retirement at or before the current age (existing copy), or past 100.
  The old "retirement must be higher" callout compared 0 with 0 and would have
  fired on a blank form.
- **No "30" / "60" placeholder.** A grey 30 in the box would read as the same
  pre-fill the report was about.
- **The footer's wellness preview waits for real ages**, as it already waited
  for income - going back and clearing the age otherwise showed a score
  worked out for a 0-year-old.
- **The `|| 30` / `|| 60` fallbacks are gone**, which also fixes the snap-back
  noted in the previous entry: clearing the age used to refill "30", and the
  next keystroke appended to it ("304").

Verified in Chrome (Browser 2), reading the DOM after each step:

```
fresh form            age ""   retire ""   Continue disabled   no warnings
28 / 60               hint "32 years of earning left to plan with"   Continue enabled
retire 25, age 28     "Retirement age needs to be higher than your current age."   disabled
age cleared           age ""   (stays empty - no snap back to 30)
age 12                "Enter an age between 16 and 100."
45 / 60 -> step 2     income 85000 -> "Wellness preview: 40/100"
back, clear age       preview hidden, Continue disabled
re-enter 45           preview back, Continue enabled
```

Tests added (2) — real output:
```
ℹ tests 83   ℹ pass 83   ℹ fail 0      (shared)
ℹ tests 78   ℹ pass 78   ℹ fail 0      (server)
ℹ tests 34   ℹ pass 34   ℹ fail 0      (web — was 32)
$ npm run lint → exit 0    $ npm run typecheck → clean    $ npm run build → built
```
195 total. Blank ages are not ready and carry no warning, either alone or
together; 32/60 is ready; retiring earlier than or at the current age, an age of
12 and a retirement age of 120 each give their message.

Anything I deliberately left out:
- **Goal target year** still falls back to 2040 when emptied (`|| 2040`), so it
  has the same snap-back. A goal needs *some* year to project, so a blank one
  wants a decision about what the card shows meanwhile - not in this report.
- **Profile page ages** stay pre-filled, correctly: that page edits values the
  user has already given.

## Fix — full-platform bug sweep  [done]

**The request:** "test for bug in every functionality and fix it."

Method: read every engine module, route, agent component and page; probed the
engine with scripts against the three personas; drove the live API
(deterministic mode, no credentials) with bad and edge-case payloads; drove the
web app in headless Chrome (typing into fields, applying actions, the
assistant). Every bug below was reproduced before it was fixed, and each fix has
a regression test.

### Engine (`@wealth/shared`)

| Bug | Effect | Fix |
|---|---|---|
| `runScenario` shifted the retirement age on the scenario profile **and** passed `retirementAgeDelta` to `assessRetirement` | "Retire 5 years earlier" was modelled as ten (Meera: 10 simulated years instead of 15) | pass the shifted profile only |
| Extra saving and lump sums went to the goals **and** in full to retirement; freed spending went to the goals and again into habitual saving | "Save 5,000 more" invested 10,000 | retirement gets only the share routed to retirement-kind goals (all of it with no goals); new optional `surplusCommitted` on `assessRetirement` |
| A crash lever with no `shockYear` | label and narration said "yr 1"; every projection skipped the shock | resolved to year 1 once, used everywhere |
| `inflationPct: 0` treated as unset (truthiness) | labelled "0.0% inflation", computed at 6% | `!== undefined` |
| Custom allocation lever re-priced goals with the risk-bucket mix | the emergency fund jumped from a 4.9% to a 7.6% return even when the "custom" mix was the recommended one | goals always use `returnForGoal` |
| Monte Carlo ignored the career break | success probability unchanged by a 36-month break | new optional `skipMonths` input, passed by `runScenario` |
| Monte Carlo applied the shock one month late | a crash at the horizon - the worst case - never landed | applied when month `shockYear*12` completes, as `accumulate` does |
| Monte Carlo rounded the horizon up to whole years | a goal 1.3 years out simulated for 2, overstating near-term success | simulated in whole months; final band at the real horizon |
| `accumulate` dropped the rest of a career break after a shock | a 36-month break with a year-1 shock credited 24 extra contributions | remaining skip months carried past the shock |
| Impact metrics paired the plan's return with the *current* holdings' volatility | a rebalance moved the median by tens of lakhs with no return change, contradicting the printed explanation | volatility of the same (recommended) mix; explanation rewritten to the real reason a figure can be negative |
| Applying a rebalance restated each class through its last holding | Aarav's RSU stayed at 42% after "Trim the RSU and realign"; one holding's cost basis stood for the class | multi-holding or single-stock classes become one fund position; average-cost basis |
| Applying "put idle cash to work" rebalanced the holdings and left the cash | Rohan's 4.06 L stayed idle and the action reappeared | new optional `fundFromCash` on `set_allocation` |
| Snowball/avalanche paid EMI + extra against the full balance | the surplus was thrown away in each debt's final month | payment capped at what is due; unneeded EMI rolls on |
| Retirement drawdown counted from a retirement age in the past | depletion age before today | starts at `max(retirementAge, age)` |
| "Or work N more years" was `min(5, ceil(10 x shortfall))` | Meera told 4 (engine: 10), Aarav 5 (five years only reaches 54%), Rohan 2 (needs 3) | searched with `assessRetirement`; grounded in the evidence |
| `formatYears` / `formatCompact` unit boundaries | "1y 12m", "₹100.0k", "₹100.00 L", "-₹0" | round first, then pick the unit |

### Server

| Bug | Effect | Fix |
|---|---|---|
| `PATCH` used `deepPartial()`, which also makes array-item fields optional | `{"goals":[{"id":"x"}]}` was stored and every later snapshot 500'd - the profile was bricked | merged profile validated with the full schema before storing |
| `assumptionOverrides: z.record(z.string(), z.any())` | `{"inflationPct":"abc"}` stored; projections came back `null`; a zero withdrawal rate divides by zero | bounded per-field schema |
| Allocation lever was `z.record(z.string(), ...)` | `{"stocks":1}` or all-zero weights priced the plan at 0% | six asset classes, at least one positive (`lib/levers.ts`) |
| Agent `simulate_scenario` / `compare_scenarios` skipped lever validation | a model writing `-35` for `-0.35` produced a negative corpus | same schema as the route; problems reported back to the model |
| `update_plan` wrote whatever it was given, and the route persists without validating | a retirement age of 62.5, a goal due in the past or an unknown kind made every later browser save fail | held to the profile schema's rules; projection looked up by id |
| `loadSession` reused any session id | one profile's turn was appended to another profile's history (and replayed it) | a foreign id starts a fresh session under a new id |
| `DynamoStore.getSession` used `Limit: 1` with a `FilterExpression` | DynamoDB applies Limit before the filter: continuing a chat overwrote its history, reopening 404'd, deleting did nothing | pages walked until found, newest first |
| Deterministic parser: units without word boundaries | "2 kids" read as 2,000; "2 credit cards" as 2 crore; "a 2008 crash ... bonus of 3 lakh" as a 2,008-crore lump sum | `\b` on every unit |
| Parser missed "crashes"/"crashed", read "2 year break" as 2 months, dropped "invest 2 lakh", ignored "next year" | answers about the wrong scenario (the +5,000/month default) | word forms, years to months, lump sums not capped by income, shock timing |
| Synthesiser templated over tool errors | "undefined is not on track ... ₹NaN"; a debt question from a debt-free profile threw and the user got "could not complete that request" | error payloads fall back to the tool's summary; debt-free guard |
| Goal answers put the *retirement* simulation straight after the goal | "8% reach the target" read as the home goal's odds | labelled as the retirement plan unless the goal is retirement |
| "Avalanche saves X" printed with `Math.abs` | claimed a saving when snowball was cheaper or equal | wording follows the sign |
| Trace labels came from a drifted hand-kept list | two tools showed as "Running estimate action impact" | read from the tool definitions |
| `describeLlmError` forwarded any error's message | the client received "Cannot read properties of undefined (reading 'unpayable')" | programming errors get a plain sentence; the raw cause stays in the log |

### Web

| Bug | Effect | Fix |
|---|---|---|
| The assistant's plan edits never reached the browser | pages showed old numbers, and the next edit anywhere PUT the stale copy back, **silently undoing the agent's change** | reload the profile after a turn that ran `update_plan` |
| Goal target year saved on every keystroke | typing 2031 stored 2, 20, 203; a past year fails validation and blocks every later save | `NumberInput`, committed only as a whole year in range (Goals and Onboarding - also closes the `\|\| 2040` snap-back left open in the previous entry) |
| Profile age accepted an age at/after retirement, and partial ages | negative horizon everywhere; the server rejected every save | commit only a whole age below retirement |
| Goal inflation, fund fee and loan rate fields re-formatted with `toFixed` per keystroke | "8.5" typed became 8.0, 8.05, 8.1 (the bug `NumberInput` was written for) | `NumberInput` |
| Goal simulation used the risk-bucket mix for every goal | an emergency fund priced on cash was simulated as equity | new `allocationForGoal` export, shared with `returnForGoal` |
| "Quantified upside" summed yearly interest, monthly flows, life-cover sums and a 30-year retirement *gap* | a meaningless headline dominated by a shortfall | replaced by the count of one-click actions |
| "Retire earlier" slider went to -10 regardless of age | a 52-year-old could "retire at 50" | min keeps retirement after today |

Files touched:
- shared: `finance/math.ts`, `finance/montecarlo.ts`, `finance/cashflow.ts`,
  `finance/engine.ts`, `finance/actions.ts`, `finance/mutations.ts`,
  `impact.ts`, `format.ts`, `types.ts`, `package.json` (test script),
  `test/regressions.test.ts` (new)
- server: `routes/profiles.ts`, `routes/planning.ts`, `routes/agent.ts`,
  `lib/levers.ts` (new), `agent/tools.ts`, `agent/intent.ts`,
  `agent/synthesis.ts`, `agent/orchestrator.ts`, `agent/llm.ts`,
  `store/index.ts`, `package.json` (test script), `test/regressions.test.ts` (new)
- web: `pages/Assistant.tsx`, `pages/Goals.tsx`, `pages/Profile.tsx`,
  `pages/Portfolio.tsx`, `pages/Onboarding.tsx`, `pages/Scenarios.tsx`,
  `pages/Actions.tsx`, `package.json` (test script),
  `test/regressions.test.tsx` (new)
- `docs/API.md` - lever rules, PATCH validation, override bounds.

Decisions I made without asking:
- **Every `@wealth/shared` API change is additive**: `allocationForGoal`,
  optional `MonteCarloInput.skipMonths`, optional
  `RetirementInput.surplusCommitted`, optional `fundFromCash` on the
  `set_allocation` mutation. No existing signature changed.
- **No existing test was changed or weakened.** "Cutting expenses frees cash"
  still holds: the scenario's displayed surplus rises; only the retirement
  projection stops counting that cash a second time.
- **A crash with no year means year 1** - what the label and narration already said.
- **A custom allocation lever applies to the retirement portfolio only**; goal
  money stays in its horizon's mix, exactly as in the baseline.
- **Rebalancing a class with several holdings, or a single stock, produces one
  fund position** at the class's blended fee; a lone fund or deposit is
  restated in place. Cost basis is average-cost (a sale keeps the cost of what
  remains, a purchase adds at market).
- **Unknown top-level override fields are dropped, not rejected**, so an older
  client cannot lock a profile out of saving; wrong types and ranges are 400s.
- **The "Quantified upside" card became "One-click actions"** rather than being
  relabelled: no label makes that sum meaningful. The dashboard's impact
  figure is the honest "what is it worth".
- **Not committed.** The working tree already held ~2,300 lines of earlier,
  uncommitted work across the same files; a commit now would bundle it with
  these fixes. Left for you to split or commit.

Tests added (38) - real output (`npm test`):
```
ℹ tests 105   ℹ pass 105   ℹ fail 0      (shared - was 83)
ℹ tests 91    ℹ pass 91    ℹ fail 0      (server - was 78)
ℹ tests 37    ℹ pass 37    ℹ fail 0      (web - was 34)
$ npm run typecheck -> exit 0    $ npm run lint -> exit 0 (0 warnings)
$ npm run synth -> build, then "Successfully synthesized"
```
233 total, up from 195. Headless Chrome (the system Chrome, driven by
playwright-core installed in a scratch directory, not the repo): every page
free of NaN/undefined and console errors; a year typed slowly is stored as 2031
with no rejected saves; "8.5" stays 8.5; age 70 is not committed; the RSU action
disappears after Apply; Rohan's idle 4.06 L moves into the portfolio; the
assistant's contribution change shows on Goals without a reload and survives a
later edit.

Anything I deliberately left out:
- **Provider paths** (Anthropic, Bedrock, Groq) were not run live - that needs
  credentials and spends money. Their unit tests pass.
- **`DynamoStore.getSession` is now correct but walks the index**; a GSI keyed
  on `sessionId` would make it one read. That is an infra change plus a deploy.
- **The engine's three private compact formatters** (`engine.ts` `compact`,
  `actions.ts` `fmt`, `goals.ts` `formatPlain`) still have the unit-boundary
  rounding `formatCompact` had ("100.0k"). Cosmetic, in action and assumption
  text only.
- **Hardcoded thresholds** - the 15% "high-cost debt" line (risk, wellness) and
  the tax rule's slabs - are not in `assumptions.ts` (constraint 5). A
  tunables task, not a bug fix.
- **`set_emergency_fund` sets liquid savings to the target** without taking the
  money from anywhere. A modelling choice worth revisiting, not a defect.
- **The profile schema's `targetYear` minimum is fixed at server start**, and a
  stored goal whose year has passed fails every save until it is edited.
- **Pinned scenario comparisons** can be scored against a not-yet-saved profile
  (600 ms debounce); the Scenario Lab edits nothing, so it does not arise today.
- **A pending debounced save is lost on a reload within 600 ms**, and the
  Actions page's "Applied" state is keyed by action id for the life of the page.
