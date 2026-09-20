# Deployment Guide

Two paths: **local** (two commands, no AWS account) and **AWS** (one CDK deploy).

---

## Part 1 — Local

### Prerequisites

- Node.js 20 or later (22 recommended — `node --version`)
- npm 10 or later

Nothing else. No AWS account, no API key, no Docker, no database.

### Run it

```bash
git clone <repository-url>
cd BroadBridge
npm install
npm run dev
```

| | |
|---|---|
| App | <http://localhost:5173> |
| API | <http://localhost:4000/api/health> |

The client proxies `/api` to the server, so both run on one origin and there is no CORS configuration to get wrong.

### Verify the install

```bash
npm run verify     # typecheck + 117 tests + build
```

### Enable the language model (optional)

Without credentials the agent runs its deterministic engine — every feature works, the prose is less fluent. To use Claude:

```bash
# Option A - Anthropic API
export ANTHROPIC_API_KEY=sk-ant-...

# Option B - Bedrock from a local AWS profile
export LLM_PROVIDER=bedrock
export AWS_REGION=us-east-1
export AWS_PROFILE=your-profile

npm run dev
```

Confirm which engine is live:

```bash
curl -s localhost:4000/api/health
# {"status":"ok","engine":"anthropic","model":"claude-opus-5",...}
```

The sidebar shows the same badge, so it is never ambiguous which engine produced an answer.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | API port |
| `LLM_PROVIDER` | auto-detected | `bedrock`, `anthropic` or `deterministic` |
| `ANTHROPIC_API_KEY` | — | Selects the `anthropic` provider when set |
| `CLAUDE_MODEL` | `claude-opus-5` | First-party model id; Bedrock adds the `anthropic.` prefix |
| `AWS_REGION` | `ap-south-1` | Region for Bedrock and DynamoDB |
| `TABLE_NAME` | — | DynamoDB table. Unset uses the in-memory store. |
| `MAX_AGENT_STEPS` | `6` | Ceiling on agent tool-calling iterations |
| `SIMULATION_PATHS` | `2000` | Monte Carlo paths per server-side run |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `CORS_ORIGINS` | `*` | Comma-separated allowlist |

Copy `.env.example` to `.env` as a starting point.

---

## Part 2 — AWS

### What gets created

| Resource | Purpose | Notes |
|---|---|---|
| CloudFront distribution | Single origin for app and API | Serves S3 at `/`, the HTTP API at `/api/*` |
| S3 bucket | React bundle | Private; reached only via Origin Access Control |
| API Gateway HTTP API | API front door | One `ANY /{proxy+}` route |
| Lambda function | Express app + agent | Node 22, ARM64, 1024 MB, 60 s timeout |
| DynamoDB table | Profiles and sessions | On-demand, single table, one GSI |
| IAM role | Lambda execution | Scoped to the table and `anthropic.*` Bedrock models |
| CloudWatch log group | Logs | 7 days (dev) / 30 days (prod) |

### Prerequisites

**1. AWS CLI configured**

```bash
aws sts get-caller-identity
```

**2. Claude model access in Bedrock**

In the AWS console: **Bedrock → Model access → Manage model access**, enable the Anthropic Claude models, and wait for `Access granted`.

Verify from the CLI:

```bash
aws bedrock list-foundation-models \
  --region us-east-1 \
  --query "modelSummaries[?contains(modelId,'anthropic')].modelId" \
  --output table
```

> Model availability is **regional**. Check your intended region before deploying. If Claude is unavailable there, the deployment still succeeds and runs the deterministic engine — the deploy workflow prints a warning saying so.

**3. Deployment permissions**

The deploying principal needs to create the resources above. `PowerUserAccess` plus `iam:*` on the stack's roles is sufficient for a hackathon; a production setup should use a purpose-built role.

**4. CDK bootstrap** — once per account and region:

```bash
cd infra
npx cdk bootstrap aws://<account-id>/<region>
```

### Deploy

```bash
npm install
npm run build           # both bundles must exist before synth

cd infra
npx cdk deploy -c stage=prod
```

Roughly 8–12 minutes on a first deploy, most of it CloudFront propagation.

Output:

```
Outputs:
WealthNavigator-prod.AppUrl = https://d1234abcd.cloudfront.net
WealthNavigator-prod.DirectApiUrl = https://abc123.execute-api.ap-south-1.amazonaws.com/
WealthNavigator-prod.DistributionId = E1234ABCDEF
WealthNavigator-prod.TableName = WealthNavigator-prod-DataTable...
```

Open `AppUrl`.

### Verify the deployment

```bash
API=https://abc123.execute-api.ap-south-1.amazonaws.com

curl -s $API/api/health          # engine should be "bedrock"
curl -s $API/api/ready           # store should be "dynamodb"

PROFILE=$(curl -s -X POST $API/api/profiles \
  -H 'content-type: application/json' \
  -d '{"personaId":"meera"}' | python -c "import sys,json;print(json.load(sys.stdin)['profile']['id'])")

curl -s $API/api/profiles/$PROFILE/snapshot | head -c 400
curl -s -X POST $API/api/agent/$PROFILE/ask \
  -H 'content-type: application/json' \
  -d '{"message":"What should I do next?"}'
curl -s -X DELETE $API/api/profiles/$PROFILE
```

If `/api/ready` reports `"store":"memory"`, the Lambda could not reach DynamoDB. The API deliberately degrades rather than failing — check the log group for the reason.

### Stages

```bash
npx cdk deploy -c stage=dev        # destroyable, debug logs, cheapest price class
npx cdk deploy -c stage=staging
npx cdk deploy -c stage=prod       # retained table, PITR, 30-day logs, all edges
```

Each stage is a separate stack with its own table and distribution. Production retains the table and bucket on stack deletion; other stages destroy them.

Other context flags:

```bash
-c claudeModel=claude-sonnet-5     # a cheaper model
-c enableBedrock=false             # deploy without the Bedrock grant
```

### Tear down

```bash
cd infra
npx cdk destroy -c stage=dev
```

Production retains the table and bucket by design; delete them manually if you intend to.

---

## Part 3 — CI/CD

### GitHub Actions

Two workflows in `.github/workflows/`.

**`ci.yml`** — every push and pull request:

1. `npm ci` (lockfile-exact)
2. Lint, typecheck, 117 tests, build
3. CDK synth — an IaC error caught here costs seconds, not a rollback
4. **Smoke test against the built artefact**, running the full demo journey
5. Dependency audit — high and critical advisories fail

The smoke job exists because of a real bug: a clean typecheck and a clean build still produced a Lambda bundle that died on startup, because the workspace package had been externalised. Only running the artefact catches that.

**`deploy.yml`** — push to `main`, or manual dispatch with a stage:

1. Re-verify (a manual dispatch can target a commit CI never saw)
2. Build
3. Assume the AWS role via OIDC — no long-lived keys in secrets
4. `cdk diff`, then `cdk deploy`
5. Post-deploy smoke test against the live URLs
6. Publish a summary and warn if the live engine is `deterministic`

### One-time setup

**1. OIDC trust.** Add GitHub as an identity provider:

- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

**2. A deployment role** trusting your repository:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": "repo:<owner>/<repo>:*" }
    }
  }]
}
```

**3. Repository configuration**

| Type | Name | Value |
|---|---|---|
| Secret | `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::<account-id>:role/<role-name>` |
| Variable | `AWS_REGION` | e.g. `ap-south-1` |

Add an `environment` per stage with required reviewers if you want manual approval before production.

### AWS CodeBuild

`buildspec.yml` at the repository root is the AWS-native equivalent, running the same gate. Set `STAGE` and `AWS_REGION` as CodeBuild environment variables and give the CodeBuild service role the deployment permissions. It skips the deploy phase on pull-request builds.

---

## Part 4 — Operating it

### Logs

```bash
aws logs tail /aws/lambda/<function-name> --follow
```

Logs are structured JSON, so CloudWatch Insights can query them directly:

```
fields @timestamp, intent, ms, engine, tools
| filter message = "agent run complete"
| sort @timestamp desc
```

Useful queries:

```
# Answers with weak grounding - the signal that a prompt change went wrong
fields @timestamp, ratio, claims
| filter message = "answer had weak grounding"

# Errors only
fields @timestamp, message, path
| filter level = "error"
```

### Cost

Rough monthly figures at demonstration scale (a few thousand requests):

| Service | Cost |
|---|---|
| Lambda | Within the free tier; ~$0.20/million requests after |
| DynamoDB on-demand | Cents at this volume |
| CloudFront | Free tier covers 1 TB out |
| S3 | Cents |
| **Bedrock** | **The only material cost** — priced per token |

Bedrock dominates. Levers, in order of effect:

1. Leave the platform in deterministic mode for demonstrations that do not need the model.
2. Set `CLAUDE_MODEL=claude-sonnet-5` for a cheaper tier.
3. Lower `MAX_AGENT_STEPS` to cap iterations per question.
4. Enable prompt caching — the system prompt and tool definitions are byte-stable across turns and are the largest repeated input.

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `/api/health` reports `deterministic` on AWS | Claude not enabled in Bedrock for that region, or the IAM grant is missing | Enable model access; confirm `enableBedrock` was not set to `false` |
| `/api/ready` reports `"store":"memory"` | Lambda cannot reach DynamoDB | Check `TABLE_NAME` and the role's table permissions in the log group |
| App loads, API calls 403 | CloudFront forwarding the `Host` header | The stack uses `ALL_VIEWER_EXCEPT_HOST_HEADER`; confirm it was not changed |
| Hard refresh on `/dashboard` 404s | SPA fallback missing | The stack rewrites 403/404 to `/index.html`; confirm both error responses exist |
| Stale bundle after deploy | `index.html` cached | The stack sets no-store on HTML and invalidates `/index.html`; check the invalidation completed |
| `cdk deploy` fails on the asset | Bundles not built | Run `npm run build` first — CDK reads `packages/*/dist` |
| `ERR_MODULE_NOT_FOUND` at Lambda start | Workspace package externalised | `noExternal: [/^@wealth\//]` in `packages/server/tsup.config.ts` |
| Slow first request | Cold start | Expected. Add provisioned concurrency if it matters. |
