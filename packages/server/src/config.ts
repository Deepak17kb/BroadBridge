/**
 * Runtime configuration, resolved once at startup.
 *
 * The platform is designed to run in three modes with no code changes:
 *   1. `deterministic` - no credentials at all. The agent still plans, calls
 *      tools and answers, using the rule engine for narration. This is what
 *      makes the repo clonable and demoable by anyone.
 *   2. `anthropic`     - ANTHROPIC_API_KEY set. Direct Claude API.
 *   3. `bedrock`       - AWS_REGION + Bedrock access. Claude via Amazon Bedrock,
 *                        which is what the deployed stack uses.
 *   4. `groq`          - GROQ_API_KEY set. Open-weights models (gpt-oss, qwen)
 *                        on Groq's inference hardware, reached over their
 *                        OpenAI-compatible endpoint. Fast and cheap; the engine,
 *                        the tools and the verifier are unchanged, so the model
 *                        only ever changes the prose.
 */

export type LlmProvider = 'bedrock' | 'anthropic' | 'groq' | 'deterministic';

/**
 * One guarded read of the environment.
 *
 * Everything below goes through this because the module is also loaded in the
 * browser - the agent runs client-side on the static build, where `process`
 * does not exist. Every field then falls back to its default, which resolves
 * the provider to `deterministic`: exactly right, since a browser bundle must
 * never carry a model key anyway.
 */
function env(name: string): string | undefined {
  if (typeof process === 'undefined' || !process.env) return undefined;
  return process.env[name];
}

function envFlag(name: string, fallback = false): boolean {
  const raw = env(name);
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const PROVIDERS: readonly LlmProvider[] = ['bedrock', 'anthropic', 'groq', 'deterministic'];

function isProvider(value: string | undefined): value is LlmProvider {
  return !!value && (PROVIDERS as readonly string[]).includes(value);
}

/** Keeps the base URL joinable, whatever shape the operator typed it in. */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end -= 1;
  return url.slice(0, end);
}

/**
 * An explicit `AGENT_TOOL_SCOPE`, or undefined to let the live provider decide.
 *
 * The scope below is derived from `resolveProvider()`, which reads the
 * environment - and in the browser there is none, so it always says
 * `deterministic` and the scope always widens to `all`. That is wrong once the
 * visitor connects their own Groq key: the browser is then talking to the same
 * per-minute-metered endpoint the server does, and needs the same narrowing.
 * The orchestrator therefore asks the client it actually holds, and only falls
 * back to this when an operator has set the variable by hand.
 */
export const agentToolScopeOverride: 'plan' | 'all' | undefined =
  env('AGENT_TOOL_SCOPE') === 'plan' || env('AGENT_TOOL_SCOPE') === 'all'
    ? (env('AGENT_TOOL_SCOPE') as 'plan' | 'all')
    : undefined;

function resolveProvider(): LlmProvider {
  const forced = env('LLM_PROVIDER')?.toLowerCase();
  if (isProvider(forced)) return forced;
  if (env('ANTHROPIC_API_KEY')) return 'anthropic';
  // Ordered after Anthropic deliberately: with both keys present the
  // first-party path wins, and GROQ_API_KEY alone is an unambiguous choice.
  if (env('GROQ_API_KEY')) return 'groq';
  // Any Lambda/ECS task with a region and an execution role can reach Bedrock.
  if (env('AWS_REGION') && envFlag('ENABLE_BEDROCK', true) && env('AWS_LAMBDA_FUNCTION_NAME'))
    return 'bedrock';
  return 'deterministic';
}

export interface AppConfig {
  port: number;
  nodeEnv: string;
  provider: LlmProvider;
  /** Model id in first-party form. The Bedrock client adds the `anthropic.` prefix. */
  model: string;
  /** Model id used when the provider is `groq`; unrelated to `model` above. */
  groqModel: string;
  /** Overridable so a Groq-compatible gateway or a test double can stand in. */
  groqBaseUrl: string;
  /**
   * Completion ceiling for the Groq path, which is lower than the orchestrator
   * asks for on purpose: narration does not need 8000 tokens, and a runaway
   * chain of thought on a reasoning model is charged as completion.
   *
   * It is not a rate-limit control. Groq meters the per-minute allowance on
   * prompt tokens plus the completion actually written, not on `max_tokens`
   * reserved - verified against a live account, where a request carrying
   * `max_tokens: 4000` was admitted with 927 tokens left in the minute and
   * cost 151. What exhausts the allowance is `agentToolScope`.
   */
  groqMaxTokens: number;
  /**
   * Total time the Groq client may spend waiting out transient failures in
   * one call. A free account asks for 9-10s mid-run, so anything under that
   * rejects the retries worth taking; past the budget the deterministic
   * engine answers immediately with the same numbers.
   */
  groqRetryBudgetMs: number;
  awsRegion: string;
  /** DynamoDB table name. When unset the server uses its in-memory store. */
  tableName?: string;
  corsOrigins: string[];
  /** Hard ceiling on agent tool-calling iterations, to bound cost and latency. */
  maxAgentSteps: number;
  /**
   * Which tools the model is offered on each step of the agent loop.
   *
   * `all` hands it the whole catalogue, which is what a provider metered on
   * requests or on spend should get: the model can always reach for the right
   * tool. `plan` narrows the schemas to the toolchain the intent router already
   * chose, plus the two every answer may need.
   *
   * The distinction exists because the catalogue is re-sent in full on every
   * step - 1,641 prompt tokens for fourteen tools, measured against Groq's
   * tokeniser. Three steps of that is 4,900 tokens of an 8,000-token minute
   * spent restating tools the plan was never going to use, which is why a
   * single question used to exhaust a free account's allowance and fall back to
   * the deterministic engine part-way through.
   */
  agentToolScope: 'plan' | 'all';
  /** Monte Carlo paths for API-triggered simulations. */
  simulationPaths: number;
  requestTimeoutMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export const config: AppConfig = {
  port: envInt('PORT', 4000),
  nodeEnv: env('NODE_ENV') ?? 'development',
  provider: resolveProvider(),
  model: env('CLAUDE_MODEL') ?? 'claude-opus-5',
  // 131k context, reliable tool use, and the best writer Groq serves.
  groqModel: env('GROQ_MODEL') ?? 'openai/gpt-oss-120b',
  groqBaseUrl: stripTrailingSlashes(env('GROQ_BASE_URL') ?? 'https://api.groq.com/openai/v1'),
  groqMaxTokens: envInt('GROQ_MAX_TOKENS', 1500),
  groqRetryBudgetMs: envInt('GROQ_RETRY_BUDGET_MS', 12_000),
  awsRegion: env('AWS_REGION') ?? 'ap-south-1',
  tableName: env('TABLE_NAME'),
  corsOrigins: (env('CORS_ORIGINS') ?? '*').split(',').map((s) => s.trim()),
  maxAgentSteps: envInt('MAX_AGENT_STEPS', 6),
  // Only the Groq path is metered on tokens per minute tightly enough for the
  // schemas to be what runs it out, so only it narrows by default. The knob is
  // read by the orchestrator, which stays free of provider branching.
  agentToolScope: agentToolScopeOverride ?? (resolveProvider() === 'groq' ? 'plan' : 'all'),
  simulationPaths: envInt('SIMULATION_PATHS', 2000),
  requestTimeoutMs: envInt('REQUEST_TIMEOUT_MS', 60_000),
  logLevel: (env('LOG_LEVEL') as AppConfig['logLevel']) ?? 'info',
};

/**
 * The model actually answering. `config.model` is the Claude id and is wrong
 * for Groq, so every place that reports the model to a user goes through here -
 * a badge that names the wrong model is worse than no badge.
 */
export function activeModel(): string | null {
  if (config.provider === 'deterministic') return null;
  return config.provider === 'groq' ? config.groqModel : config.model;
}

/** Bedrock expects the model id prefixed with the provider name. */
export function bedrockModelId(model: string): string {
  return model.startsWith('anthropic.') ? model : `anthropic.${model}`;
}
