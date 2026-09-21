import Anthropic from '@anthropic-ai/sdk';
import { bedrockModelId, config, type LlmProvider } from '../config.js';
import { logger } from '../lib/logger.js';
import {
  GroqStreamAccumulator,
  type GroqUsage,
  parseSseStream,
  retryDelayMs,
  sleep,
  toAnthropicMessage,
  toGroqPayload,
} from './groq.js';

/** Matches the `maxRetries: 2` the Anthropic SDK applies on the other paths. */
const GROQ_MAX_RETRIES = 2;

/**
 * One interface over every way of reaching a model.
 *
 * `bedrock` is what the deployed stack uses - the Lambda's execution role
 * carries the Bedrock permission, so there is no API key to store or rotate
 * anywhere in the system. `anthropic` is the convenient local path. Both go
 * through the official SDK, so tool-use shapes, streaming and error types are
 * identical and the orchestrator does not branch on provider.
 *
 * `groq` reaches open-weights models over an OpenAI-compatible endpoint, so it
 * is the one provider whose wire format differs. `groq.ts` absorbs that
 * difference and returns the same `Anthropic.Message`, which is what keeps the
 * orchestrator free of provider branching. The model still only narrates: the
 * tools, the engine and the grounding verifier are identical on every path.
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

/** A Groq HTTP failure, carrying the status so the UI can say something useful. */
export class GroqApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GroqApiError';
  }
}

/** Groq reports failures as `{ error: { message } }`; fall back to the raw body. */
function describeGroqFailure(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    /* not JSON - the status and the raw text are all there is */
  }
  return body.trim().slice(0, 200) || `Groq returned HTTP ${status}`;
}

class GroqClient implements LlmClient {
  readonly provider = 'groq' as const;
  readonly model: string;

  constructor(
    private readonly apiKey: string,
    model: string,
    private readonly baseUrl: string,
  ) {
    this.model = model;
  }

  /**
   * Retries transient failures before giving up, which is what the Anthropic
   * path already gets for free from `maxRetries: 2` in the SDK. Without it the
   * Groq path was the least resilient of the three, and a token allowance that
   * refills a second later would end the turn.
   *
   * Retrying here rather than around the whole call is deliberate: this runs
   * before the response body is touched, so no tokens have streamed yet and a
   * retry cannot duplicate text in the user's answer.
   */
  private async post(params: LlmRequest, stream: boolean): Promise<Response> {
    const body = JSON.stringify(toGroqPayload(params, this.model, stream, config.groqMaxTokens));
    let spentMs = 0;

    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        // The SDK paths get their timeout from the client; this one needs it
        // here, or a stalled stream would hold an SSE connection open forever.
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });

      if (response.ok) return response;

      const text = await response.text().catch(() => '');
      const detail = describeGroqFailure(response.status, text);
      const wait = retryDelayMs({
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        detail,
        attempt,
        maxRetries: GROQ_MAX_RETRIES,
        spentMs,
        budgetMs: config.groqRetryBudgetMs,
      });

      // The user-facing wording is deliberately generic, so the operator's copy
      // of the reason - which names the actual quota - is logged here or lost.
      logger.warn('groq request failed', {
        status: response.status,
        model: this.model,
        detail,
        limitTokens: response.headers.get('x-ratelimit-limit-tokens'),
        remainingTokens: response.headers.get('x-ratelimit-remaining-tokens'),
        retryInMs: wait,
      });

      if (wait === null) throw new GroqApiError(response.status, detail);
      spentMs += wait;
      await sleep(wait);
    }
  }

  /**
   * Groq meters a free account on tokens *per minute*, and the agent loop spends
   * that allowance several calls at a time, so when a run falls back to the
   * deterministic engine the only useful question is which call was expensive.
   * Recording it per call answers that without a reproduction.
   */
  private meter(usage: GroqUsage | undefined): void {
    logger.debug('groq call metered', {
      model: this.model,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
    });
  }

  async createMessage(params: LlmRequest): Promise<Anthropic.Message> {
    const response = await this.post(params, false);
    const json = (await response.json()) as Record<string, any>;
    const choice = json.choices?.[0];
    this.meter(json.usage as GroqUsage | undefined);
    return toAnthropicMessage({
      id: typeof json.id === 'string' ? json.id : 'groq-message',
      model: typeof json.model === 'string' ? json.model : this.model,
      text: choice?.message?.content ?? '',
      toolCalls: choice?.message?.tool_calls ?? [],
      finishReason: choice?.finish_reason,
      usage: json.usage,
    });
  }

  async streamText(
    params: LlmRequest,
    onDelta: (text: string) => void,
  ): Promise<Anthropic.Message> {
    const response = await this.post(params, true);
    if (!response.body) {
      throw new GroqApiError(502, 'Groq returned a streaming response with no body');
    }

    const accumulator = new GroqStreamAccumulator();
    for await (const chunk of parseSseStream(response.body)) {
      // `accept` returns only the user-visible text. gpt-oss streams its chain
      // of thought in a sibling field, and forwarding that would print the
      // model's private reasoning into the answer.
      const text = accumulator.accept(chunk);
      if (text) onDelta(text);
    }

    this.meter(accumulator.usage);
    return toAnthropicMessage({
      id: accumulator.id || 'groq-message',
      model: this.model,
      text: accumulator.text,
      toolCalls: accumulator.toolCalls(),
      finishReason: accumulator.finishReason,
      usage: accumulator.usage,
    });
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

    if (config.provider === 'groq') {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) throw new Error('provider is groq but GROQ_API_KEY is not set');
      logger.info('LLM ready', {
        provider: 'groq',
        model: config.groqModel,
        endpoint: config.groqBaseUrl,
      });
      cached = new GroqClient(apiKey, config.groqModel, config.groqBaseUrl);
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

/**
 * Narrows an error into something worth showing a user.
 *
 * Everything here is terminal. Retries - the SDK’s on the Anthropic and
 * Bedrock paths, this module’s own on the Groq one - are already spent by the
 * time a failure reaches this function, and the caller’s next move is the
 * deterministic engine. So the copy must not promise a retry that will never
 * happen; it says what is actually about to occur.
 */
export function describeLlmError(error: unknown): { message: string; recoverable: boolean } {
  // Groq speaks HTTP rather than the SDK's error classes, so it is narrowed on
  // status. The wording matches the Anthropic branches below on purpose: which
  // provider is configured is not the user's problem.
  if (error instanceof GroqApiError) {
    if (error.status === 429) {
      return { message: 'The reasoning service is rate limited. Answering with the deterministic engine instead.', recoverable: true };
    }
    if (error.status === 401 || error.status === 403) {
      return { message: 'Reasoning service credentials were rejected.', recoverable: false };
    }
    if (error.status >= 500) {
      return { message: `Reasoning service error (${error.status}).`, recoverable: true };
    }
    return { message: `Reasoning request was rejected: ${error.message}`, recoverable: false };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { message: 'The reasoning service is rate limited. Answering with the deterministic engine instead.', recoverable: true };
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
  // A programming error's message is an internal detail - the client was sent
  // "Cannot read properties of undefined (reading 'unpayable')" verbatim. The
  // stack is logged by the caller; the user gets a plain sentence.
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError) {
    return { message: 'Something went wrong while preparing that answer.', recoverable: false };
  }
  return {
    message: error instanceof Error ? error.message : 'Unknown reasoning failure',
    recoverable: false,
  };
}
