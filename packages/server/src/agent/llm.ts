import Anthropic from '@anthropic-ai/sdk';
import { bedrockModelId, config, type LlmProvider } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * One interface over three ways of reaching Claude.
 *
 * `bedrock` is what the deployed stack uses - the Lambda's execution role
 * carries the Bedrock permission, so there is no API key to store or rotate
 * anywhere in the system. `anthropic` is the convenient local path. Both go
 * through the official SDK, so tool-use shapes, streaming and error types are
 * identical and the orchestrator does not branch on provider.
 */

export interface LlmClient {
  readonly provider: Exclude<LlmProvider, 'deterministic'>;
  readonly model: string;
  createMessage(params: LlmRequest): Promise<Anthropic.Message>;
  streamText(params: LlmRequest, onDelta: (text: string) => void): Promise<Anthropic.Message>;
}

export interface LlmRequest {
  system: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  maxTokens?: number;
  /** Controls how hard the model thinks. `low` for classification, `high` for advice. */
  effort?: 'low' | 'medium' | 'high';
  toolChoice?: Anthropic.MessageCreateParams['tool_choice'];
}

function buildClient(): Anthropic | null {
  if (config.provider === 'anthropic') {
    // Zero-arg construction resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or
    // a CLI profile - never hardcode a key.
    return new Anthropic({ maxRetries: 2, timeout: config.requestTimeoutMs });
  }
  return null;
}

class AnthropicClient implements LlmClient {
  readonly provider = 'anthropic' as const;
  readonly model = config.model;

  constructor(private readonly client: Anthropic) {}

  private common(params: LlmRequest): Anthropic.MessageCreateParams {
    return {
      model: this.model,
      max_tokens: params.maxTokens ?? 8000,
      system: params.system,
      messages: params.messages,
      ...(params.tools ? { tools: params.tools } : {}),
      ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
      // Adaptive thinking on Claude Opus 5; `budget_tokens` is rejected there.
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: params.effort ?? 'high' },
    };
  }

  async createMessage(params: LlmRequest): Promise<Anthropic.Message> {
    return this.client.messages.create({ ...this.common(params), stream: false });
  }

  async streamText(
    params: LlmRequest,
    onDelta: (text: string) => void,
  ): Promise<Anthropic.Message> {
    const stream = this.client.messages.stream(this.common(params));
    stream.on('text', onDelta);
    // finalMessage() collects the whole response so the caller can inspect
    // stop_reason and tool_use blocks without wiring up event handlers.
    return stream.finalMessage();
  }
}

class BedrockClient implements LlmClient {
  readonly provider = 'bedrock' as const;
  readonly model: string;

  constructor(private readonly client: any, model: string) {
    this.model = model;
  }

  private common(params: LlmRequest): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: params.maxTokens ?? 8000,
      system: params.system,
      messages: params.messages,
      ...(params.tools ? { tools: params.tools } : {}),
      ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: params.effort ?? 'high' },
    };
  }

  async createMessage(params: LlmRequest): Promise<Anthropic.Message> {
    return this.client.messages.create({ ...this.common(params), stream: false });
  }

  async streamText(
    params: LlmRequest,
    onDelta: (text: string) => void,
  ): Promise<Anthropic.Message> {
    const stream = this.client.messages.stream(this.common(params));
    stream.on('text', onDelta);
    return stream.finalMessage();
  }
}

let cached: LlmClient | null | undefined;

/**
 * Returns a client, or null when the platform is running in deterministic mode.
 * Resolved lazily and cached: a cold Lambda should not pay for client
 * construction until the first agent call actually needs it.
 */
export async function getLlm(): Promise<LlmClient | null> {
  if (cached !== undefined) return cached;

  if (config.provider === 'deterministic') {
    logger.info('LLM disabled - running the deterministic reasoning engine', {
      reason: 'no credentials configured',
    });
    cached = null;
    return cached;
  }

  try {
    if (config.provider === 'bedrock') {
      // Imported dynamically so a deployment that never touches Bedrock does not
      // pay the module-load cost.
      const sdk: any = await import('@anthropic-ai/bedrock-sdk');
      // Prefer the Messages-API Bedrock endpoint; fall back to the legacy
      // InvokeModel client if the installed SDK predates it.
      const Ctor = sdk.AnthropicBedrockMantle ?? sdk.AnthropicBedrock;
      if (!Ctor) throw new Error('@anthropic-ai/bedrock-sdk exposes no usable client');
      const client = new Ctor({ awsRegion: config.awsRegion });
      const model = sdk.AnthropicBedrockMantle ? bedrockModelId(config.model) : config.model;
      logger.info('LLM ready', { provider: 'bedrock', model, region: config.awsRegion });
      cached = new BedrockClient(client, model);
      return cached;
    }

    const client = buildClient();
    if (!client) throw new Error('no Anthropic credentials resolved');
    logger.info('LLM ready', { provider: 'anthropic', model: config.model });
    cached = new AnthropicClient(client);
    return cached;
  } catch (error) {
    // A missing key or an unreachable Bedrock endpoint must not break the
    // product - the deterministic engine keeps every feature working.
    logger.error('LLM unavailable, falling back to the deterministic engine', {
      provider: config.provider,
      message: error instanceof Error ? error.message : String(error),
    });
    cached = null;
    return cached;
  }
}

/** Test seam. */
export function resetLlm(): void {
  cached = undefined;
}

/** Narrows an SDK error into something worth showing a user. */
export function describeLlmError(error: unknown): { message: string; recoverable: boolean } {
  if (error instanceof Anthropic.RateLimitError) {
    return { message: 'The reasoning service is rate limited. Retrying shortly.', recoverable: true };
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return { message: 'Reasoning service credentials were rejected.', recoverable: false };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { message: `Reasoning request was rejected: ${error.message}`, recoverable: false };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { message: 'Could not reach the reasoning service.', recoverable: true };
  }
  if (error instanceof Anthropic.APIError) {
    return { message: `Reasoning service error (${error.status}).`, recoverable: (error.status ?? 500) >= 500 };
  }
  return {
    message: error instanceof Error ? error.message : 'Unknown reasoning failure',
    recoverable: false,
  };
}
