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
