# CLAUDE.md — working agreement for this repo

Source of truth for the work queue: `IMPLEMENTATION.md`. Progress log: `PROGRESS.md`.
This file exists so the constraints below survive a context reset. Read it first.

---

## HARD CONSTRAINTS — these override any task

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

---

## AUTONOMY PROTOCOL — summary

**Work independently. Do not ask for approval to do the job.**

No permission needed to plan, read, write code, create files, run tests, run the linter, fix
what you broke, name a variable, pick a file path, write copy, or move to the next task. Decide
and proceed. Where the brief is underspecified, choose the option most consistent with the
existing codebase and record the choice in `PROGRESS.md`. Work straight down the **Execution
order** in `IMPLEMENTATION.md`; when a task is done, commit it and start the next one.

### Stop and ask only for these

1. **Anything that spends money or touches live AWS** — `cdk deploy`, `cdk destroy`, creating
   AWS resources, Bedrock calls against a real account, anything needing credentials. Writing
   and `cdk synth`-ing infrastructure is free; deploying it is not.
2. **Anything involving a git remote** — `git init`, branches and local commits are yours.
   Creating a remote, pushing, force-pushing, rewriting published history is not.
3. **New runtime dependencies.** Dev-only tooling implied by a task (Playwright, axe-core, k6)
   is fine. Anything shipping to the browser or the Lambda bundle: ask, with the package name,
   its size, and why nothing already installed will do.
4. **Deleting or weakening an existing test.** If an existing test fails, the default assumption
   is that your code is wrong. If the test genuinely encodes a wrong expectation, stop and show
   the test, the failure, and the reasoning.
5. **Destructive filesystem or data operations** — deleting directories, `rm -rf`, dropping a
   table, truncating a data file, mass find-and-replace across the repo.
6. **A breaking change to the `@wealth/shared` public API.** Additive changes are yours.
   Changing or removing an exported signature other packages consume: ask.
7. **The T11 security model.** Post the two-paragraph threat model in `PROGRESS.md` and wait
   before writing any of it.
8. **Scope reality check.** If a task is more than roughly twice the work the brief implies,
   stop, say so, and propose a smaller version.

Anything not on that list: just do it. Keep working on other tasks while something is blocked —
never idle waiting for an answer.

### Never claim something works without proof

Do not write "done", "working" or "passing" without running the thing and pasting the real
output — not a summary of it. A task is complete when `npm test`, `npm run lint` and
`npm run typecheck` all pass and the output has been shown.

### Progress log format

Append to `PROGRESS.md` after each task:

```
## T<n> — <title>  [done | partial | blocked]
Files touched:
Decisions I made without asking:
Tests added (and the real `npm test` output line):
Anything I deliberately left out:
```

Keep a `## BLOCKED` section at the top for anything from the stop list awaiting an answer.

---

## Repo orientation

```
packages/shared/   domain types, market assumptions, the whole finance engine   (46 tests)
packages/server/   Express API, agent orchestrator, 12 tools, BM25 retrieval    (42 tests)
packages/web/      React 18 + Vite client                                       (29 tests)
infra/             AWS CDK stack (CloudFront, S3, HTTP API, Lambda, DynamoDB)
docs/              ARCHITECTURE, API, DEPLOYMENT, DEMO_SCRIPT, deck
```

Commands: `npm run dev` · `npm test` · `npm run lint` · `npm run typecheck` · `npm run build`
· `npm run verify` (the CI gate) · `npm run synth`

Run modes, selected by environment with no code change: `deterministic` (no credentials at all,
full feature set), `anthropic` (`ANTHROPIC_API_KEY`), `bedrock` (region + Lambda execution role).
