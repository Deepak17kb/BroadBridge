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
 */

export type LlmProvider = 'bedrock' | 'anthropic' | 'deterministic';

function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveProvider(): LlmProvider {
  const forced = process.env.LLM_PROVIDER?.toLowerCase();
  if (forced === 'bedrock' || forced === 'anthropic' || forced === 'deterministic') return forced;
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  // Any Lambda/ECS task with a region and an execution role can reach Bedrock.
  if (process.env.AWS_REGION && envFlag('ENABLE_BEDROCK', true) && process.env.AWS_LAMBDA_FUNCTION_NAME)
    return 'bedrock';
  return 'deterministic';
}

export interface AppConfig {
  port: number;
  nodeEnv: string;
  provider: LlmProvider;
  /** Model id in first-party form. The Bedrock client adds the `anthropic.` prefix. */
  model: string;
  awsRegion: string;
  /** DynamoDB table name. When unset the server uses its in-memory store. */
  tableName?: string;
  corsOrigins: string[];
  /** Hard ceiling on agent tool-calling iterations, to bound cost and latency. */
  maxAgentSteps: number;
  /** Monte Carlo paths for API-triggered simulations. */
  simulationPaths: number;
  requestTimeoutMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export const config: AppConfig = {
  port: envInt('PORT', 4000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  provider: resolveProvider(),
  model: process.env.CLAUDE_MODEL ?? 'claude-opus-5',
  awsRegion: process.env.AWS_REGION ?? 'ap-south-1',
  tableName: process.env.TABLE_NAME,
  corsOrigins: (process.env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()),
  maxAgentSteps: envInt('MAX_AGENT_STEPS', 6),
  simulationPaths: envInt('SIMULATION_PATHS', 2000),
  requestTimeoutMs: envInt('REQUEST_TIMEOUT_MS', 60_000),
  logLevel: (process.env.LOG_LEVEL as AppConfig['logLevel']) ?? 'info',
};

/** Bedrock expects the model id prefixed with the provider name. */
export function bedrockModelId(model: string): string {
  return model.startsWith('anthropic.') ? model : `anthropic.${model}`;
}
