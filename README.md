# AI Wealth Navigator

<!-- Replace OWNER/REPO once the GitHub remote exists; docs/DEPLOYMENT.md (Part 3, one-time setup) has the exact steps. -->
[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)
[![Deploy](https://github.com/OWNER/REPO/actions/workflows/deploy.yml/badge.svg)](https://github.com/OWNER/REPO/actions/workflows/deploy.yml)
![Tests](https://img.shields.io/badge/tests-117%20passing-brightgreen)
![Node](https://img.shields.io/badge/node-%3E%3D20-blue)
![Licence](https://img.shields.io/badge/data-synthetic%20only-orange)

An AI-powered financial wellness platform. It reads a user's actual position, projects every goal, lets them explore what-if scenarios against thousands of simulated markets, and produces ranked next-best actions — each one showing the arithmetic and the assumptions behind it.

**All data is synthetic. Nothing here is financial advice.**

---

## Run it in two commands

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. Pick a sample profile or enter your own numbers.

**No API key is needed.** With no credentials the agent still classifies the question, plans a toolchain, runs the financial engine and answers with grounded figures — it just narrates through a rule-based synthesiser instead of Claude. Add credentials to switch the language model on:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or deploy to AWS and use Bedrock
```

The active engine is shown in the sidebar and returned by `GET /api/health`, so it is never ambiguous which one produced an answer.

---

## What it does

| | |
|---|---|
| **Onboarding** | Five-step wizard, or one click to load a sample profile. The wellness score and surplus update live as you type. |
| **Dashboard** | Wellness score across five weighted pillars, net worth, cashflow, goal funding, allocation versus target, retirement readiness. |
| **Goals** | Per-goal projection with inflation applied to the target date. Test a contribution change with sliders, then commit it. |
| **Scenario Lab** | Nine levers — save more, spend less, retire earlier, lump sum, market crash, career break, inflation, pay rise, allocation. Every drag re-runs the model in the browser. Pin scenarios to compare them. |
| **Portfolio** | Covariance-based volatility, drift from target, exact rebalancing trades, fee drag, concentration on single securities only, avalanche vs snowball debt payoff. |
| **Next Best Actions** | Twelve rule checks producing ranked, quantified actions. Each has an **Apply to my plan** button that actually mutates the plan. |
| **AI Assistant** | Ask in plain language. The reasoning trace shows the plan, every tool call with timing, retrieved knowledge, and a grounding check on every figure in the answer. |
| **Assumptions** | Every assumption the platform uses, editable. Change inflation or the withdrawal rate and the whole plan re-scores. Includes what is deliberately *not* modelled. |

---

## Architecture in one picture

```
          ┌──────────────── CloudFront (one origin) ────────────────┐
          │                                                         │
   S3 ◄───┤  /  and /assets/*          /api/*  ──► HTTP API         │
   React  │                                          │              │
   bundle └──────────────────────────────────────────┼──────────────┘
                                                     ▼
                                              Lambda (Node 22)
                                              Express + agent
                                                │        │
                                    DynamoDB ◄──┘        └──► Bedrock
                                  (single table)              (Claude)
```

**The load-bearing idea:** one financial engine, `@wealth/shared`, imported as TypeScript source by both the browser and the Lambda.

- The browser runs it for instant slider feedback — no round trip to see a what-if.
- The agent's tools call the same functions server-side.
- There is no second implementation, so the number on the slider and the number the AI quotes cannot disagree.

**The second load-bearing idea:** the model narrates, it never calculates. Every figure comes from a tool result, and a verifier re-checks each number in the answer against the tool outputs that produced it. Unmatched figures are reported as unverified rather than trusted.

Full detail, including the decisions and their trade-offs: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Repository layout

```
packages/
  shared/    Domain types, market assumptions, the whole finance engine + 46 tests
  server/    Express API, agent orchestrator, tools, BM25 retrieval + 42 tests
  web/       React 18 + Vite client + 29 smoke-render tests
infra/       AWS CDK stack (CloudFront, S3, HTTP API, Lambda, DynamoDB, Bedrock IAM)
docs/        Architecture, deployment guide, API reference, demo script, slide deck
.github/     CI and deploy workflows
buildspec.yml  AWS CodeBuild equivalent of the CI pipeline
```

---

## Commands

```bash
npm run dev         # API on :4000 and the client on :5173, both watching
npm run typecheck   # All four packages
npm test            # 117 tests: engine arithmetic, API + agent, page renders
npm run lint        # ESLint, zero warnings tolerated
npm run build       # Lambda bundle + static client bundle
npm run verify      # typecheck + test + build, the same gate CI runs
npm run synth       # Build, then synthesize the CDK stack
npm run deploy      # Build, then deploy to AWS
```

---

## Deploying

```bash
npm run build
cd infra
npx cdk bootstrap                  # once per account and region
npx cdk deploy WealthNavigator-prod -c stage=prod
```

The stack outputs an `AppUrl`. Requires Claude model access enabled in Amazon Bedrock for your region — without it the deployment still works and runs the deterministic engine, and the deploy workflow prints a warning saying so.

Step-by-step, including IAM setup and cost estimates: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

---

## What is tested

117 tests, all runnable with `npm test` and no credentials.

**Engine (46)** — the maths is the product, so it is tested as such. Solver round-trips (the contribution the engine says is required is fed back through the projection and must land on the target), reproducibility of every seeded simulation, percentile band ordering, and the variance-drag correction that stops a Monte Carlo from silently overstating the median. Invariants hold for all three personas: net worth reconciles, pillar weights sum to 1, allocations sum to 1, actions arrive ranked and every one carries assumptions.

**API and agent (42)** — real HTTP against a listening server, so serialisation and status codes are exercised. Intent routing, natural-language lever extraction, BM25 retrieval accuracy, every tool's output shape, the grounding verifier, SSE frame validity, and a full conversation round-trip. One test asserts that the persona with 42% credit-card debt is told to clear it before investing.

**Client (29)** — every page server-side rendered for all three personas plus an empty profile, asserting no `NaN`, `undefined` or `Infinity` reaches the user. This is the layer a typecheck cannot cover.

---

## Deliberate limitations

Stated because an unstated omission is a misleading result. The Assumptions page lists these in the product too.

- **No taxes.** No capital gains, dividend or income tax on any projection. Real after-tax outcomes are lower.
- **No transaction costs.** Brokerage, exit loads, spreads and rebalancing costs are excluded.
- **Thin tails.** Returns are log-normal and drawn independently. Real markets crash harder, more often, and in clusters.
- **Synthetic data only.** No real market data, no real accounts, no institution integrated.
- **Not advice.** Illustrative planning output from a hackathon build, not a regulated recommendation.

---

## Licence

Built for a hackathon. Synthetic data throughout.
