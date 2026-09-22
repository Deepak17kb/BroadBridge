# Deployment Guide

How to run this platform, from a laptop to a public URL. Three targets, in the
order you are likely to need them.

| Target | AI assistant | Persistence | Setup |
|---|---|---|---|
| [Local development](#1-local-development) | Yes | In-memory | `npm install && npm run dev` |
| [GitHub Pages](#2-github-pages--the-public-demo) | No — see [why](#why-the-assistant-cannot-run-on-pages) | Browser `localStorage` | Push to `main` |
| [Any Node host](#3-any-node-host--the-full-platform) | Yes | In-memory, or add a store | One build, one process |

Prerequisites everywhere: **Node 20 or newer** (`node -v`). No database, no cloud
account and no API key is required to run the platform — the agent falls back to
a deterministic engine that plans, calls the same tools and grounds every figure.

---

## 1. Local development

```bash
git clone https://github.com/Deepak17kb/BroadBridge.git
cd BroadBridge
npm install
npm run dev
```

Open <http://localhost:5173>.

`npm run dev` starts two processes side by side:

- **API** on `:4000` — Express, watched by `tsx`
- **Client** on `:5173` — Vite, with hot reload

Vite proxies `/api` to `:4000`, so the browser sees a single origin. There is no
CORS to configure and no environment variable to set for the client to find the
server.

### Turning the language model on

Optional. Copy `.env.example` to `.env` and set **one** of:

```bash
ANTHROPIC_API_KEY=sk-ant-...     # Claude, via the Anthropic API
GROQ_API_KEY=gsk_...             # open-weights models on Groq
```

Which engine is live is never ambiguous — it is shown in the sidebar and
returned by `GET /api/health`:

```bash
curl localhost:4000/api/health
# {"status":"ok","engine":"groq","model":"openai/gpt-oss-120b",...}
```

`engine: "deterministic"` means no credentials were found. Everything still
works; the assistant narrates from templates instead of a model.

**Never commit `.env`.** It is in `.gitignore`, and it must stay out of any
archive you share.

---

## 2. GitHub Pages — the public demo

This is what <https://deepak17kb.github.io/BroadBridge/> serves. It exists so
anyone can open a link and use the product with no install and no account.

### How it is published

**[.github/workflows/pages.yml](../.github/workflows/pages.yml)** runs on every
push to `main`. It needs no secrets at all:

```bash
VITE_STATIC=true VITE_BASE=/<repo-name>/ npm run build --workspace @wealth/web
cp packages/web/dist/index.html packages/web/dist/404.html
```

Three things are load-bearing there:

- **`VITE_STATIC=true`** selects `packages/web/src/lib/staticApi.ts` instead of
  the network client. Pages serves files, not processes, so there is no Express
  to answer `/api`. Every route the client actually calls is either a pure
  function of the profile or a read of it, and the finance engine is already
  compiled into the bundle — so the browser computes the same numbers the server
  would, and `localStorage` holds the profile. It is not a mock.
- **`VITE_BASE`** sets the asset prefix. A GitHub project site is served from
  `/<repo>/`, not from the domain root, and the workflow derives it from the
  repository name so a fork works unedited.
- **`404.html`** is a byte-for-byte copy of `index.html`. Pages has no rewrite
  rules, so a hard refresh on a deep link like `/goals` is a miss; Pages serves
  `404.html` for any miss, the app boots from it, and the router resolves the
  path.

### One-time repository setup

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   Equivalently, from the CLI:
   ```bash
   gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow
   ```
2. Push to `main`. The workflow builds, uploads the artefact and deploys.
3. The URL appears in the workflow's `deploy` job output and under Settings →
   Pages.

### Why the assistant cannot run on Pages

It needs a model, a model needs an API key, and a key inside a public bundle is
a key anyone can read by opening DevTools. So the static build does not ship
one, and the Assistant page says so plainly rather than failing silently. Use
local development or a Node host for the assistant.

---

## 3. Any Node host — the full platform

For a public URL **with** the assistant working: Render, Railway, Fly.io, an EC2
instance, a container — anything that runs a Node process and holds an
environment variable.

```bash
npm ci
npm run build                      # server bundle + client bundle
npm start --workspace @wealth/server
```

| Setting | Value |
|---|---|
| Build command | `npm ci && npm run build` |
| Start command | `npm start --workspace @wealth/server` |
| Health check | `GET /api/health` |
| Port | `PORT` env var, default `4000` |

Serve `packages/web/dist` as static files and proxy `/api` to the Node process,
or put both behind one reverse proxy so they share an origin. If they must live
on different origins, set `VITE_API_URL` at build time and `CORS_ORIGINS` on the
server.

Set `ANTHROPIC_API_KEY` or `GROQ_API_KEY` in the host's environment — never in
the repository.

### Persistence

The server ships an in-memory store, so profiles reset when the process
restarts. That is deliberate for a demo. To persist, implement the `Store`
interface in `packages/server/src/store/index.ts` — eight methods, all
straightforward — and return it from `getStore()`. Nothing else in the codebase
needs to change; the routes and the agent only ever see that interface.

---

## Environment variables

Every one has a working default. The platform runs with none of them set.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4000` | API port |
| `NODE_ENV` | `development` | Standard |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `ANTHROPIC_API_KEY` | — | Turns on Claude |
| `GROQ_API_KEY` | — | Turns on open-weights models |
| `LLM_PROVIDER` | auto-detected | Force `anthropic`, `groq` or `deterministic` |
| `CLAUDE_MODEL` | `claude-opus-5` | Model id for the Anthropic path |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Model id for the Groq path |
| `MAX_AGENT_STEPS` | `6` | Ceiling on agent tool-calling iterations |
| `SIMULATION_PATHS` | `2000` | Monte Carlo paths per server-side run |
| `CORS_ORIGINS` | `*` | Comma-separated allowlist |
| `VITE_API_URL` | — | Client build: absolute API base, if not same-origin |
| `VITE_STATIC` | — | Client build: `true` selects the browser-only client |
| `VITE_BASE` | `/` | Client build: asset path prefix |

The full annotated list is in [`.env.example`](../.env.example).

---

## CI/CD

**[.github/workflows/ci.yml](../.github/workflows/ci.yml)** runs on every push
and pull request:

1. `npm ci`
2. `npm run typecheck` — all three packages
3. `npm test` — 239 tests
4. `npm run build` — server and client bundles
5. An end-to-end demo journey against a live API process

**[.github/workflows/pages.yml](../.github/workflows/pages.yml)** publishes the
static site on every push to `main`. It cancels an in-flight run when a newer
commit arrives, so the site always reflects the tip of `main` rather than
whichever build happened to finish last.

Both are green on `main`. Neither needs a secret.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find module` on `npm run dev` | Dependencies not installed | `npm install` |
| Port 4000 or 5173 already in use | A previous dev server is still running | Stop it, or set `PORT` |
| Assistant says it needs the API server | You are on the Pages build | Run locally, or deploy to a Node host |
| Assistant answers but the sidebar says "Deterministic engine" | No API key found | Set `ANTHROPIC_API_KEY` or `GROQ_API_KEY`, restart |
| Pages site loads blank | `VITE_BASE` does not match the repo name | Check the asset paths in the published `index.html` |
| Deep link 404s on refresh | `404.html` was not created | Re-run the Pages workflow; it copies `index.html` |
| Profile disappeared on the Pages site | It lives in `localStorage` | Expected — it is per-browser, and cleared site data removes it |

---

## A note on data

All sample data is synthetic and fabricated for this project. No real market
data, no real accounts, no financial institution is integrated, and nothing the
platform outputs is financial advice. The assumptions behind every projection
are illustrative long-run planning figures, editable in the product on the
Assumptions page.
