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
