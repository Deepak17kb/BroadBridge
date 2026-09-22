import type Anthropic from '@anthropic-ai/sdk';
import {
  GroqStreamAccumulator,
  parseSseStream,
  retryDelayMs,
  sleep,
  toAnthropicMessage,
  toGroqPayload,
} from '@agent/groq.js';
import type { LlmClient, LlmRequest } from './llmShim';
import { readModelKey } from './browserKey';

/**
 * Groq, called straight from the browser.
 *
 * Groq answers with `access-control-allow-origin: *`, so a page may call it
 * without a proxy. That is what lets the static deployment run a real model:
 * the visitor supplies their own key (see `browserKey.ts`), their browser talks
 * to `api.groq.com`, and no server exists in between.
 *
 * Every byte of wire format comes from `@agent/groq.ts` - the same module the
 * server uses - so the payload shape, the tool-call translation, the SSE
 * accumulator and the retry policy cannot drift between the two paths. This
 * file is only the transport.
 */

const MAX_RETRIES = 2;
const RETRY_BUDGET_MS = 12_000;
const TIMEOUT_MS = 60_000;
const MAX_TOKENS = 1500;

/** A Groq HTTP failure, carrying the status so the UI can say something useful. */
export class BrowserGroqError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserGroqError';
  }
}

function describeFailure(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    /* not JSON - the status and the raw text are all there is */
  }
  return body.trim().slice(0, 200) || `Groq returned HTTP ${status}`;
}

class BrowserGroqClient implements LlmClient {
  readonly provider = 'groq' as const;

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly baseUrl = 'https://api.groq.com/openai/v1',
  ) {}

  /**
   * Retries transient failures before giving up, as the server path does.
   *
   * A free Groq account meters 8,000 tokens a minute and asks for a wait of a
   * few seconds when a run crosses it, so without this the second question in
   * quick succession would fall back to the deterministic engine for want of
   * waiting three seconds. Retrying before the body is touched means no tokens
   * have streamed yet, so a retry cannot duplicate text in the answer.
   */
  private async post(params: LlmRequest, stream: boolean): Promise<Response> {
    const body = JSON.stringify(toGroqPayload(params, this.model, stream, MAX_TOKENS));
    let spentMs = 0;

    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) return response;

      const text = await response.text().catch(() => '');
      const detail = describeFailure(response.status, text);
      const wait = retryDelayMs({
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        detail,
        attempt,
        maxRetries: MAX_RETRIES,
        spentMs,
        budgetMs: RETRY_BUDGET_MS,
      });
      if (wait === null) throw new BrowserGroqError(response.status, detail);
      spentMs += wait;
      await sleep(wait);
    }
  }

  async createMessage(params: LlmRequest): Promise<Anthropic.Message> {
    const response = await this.post(params, false);
    const json = (await response.json()) as Record<string, any>;
    const choice = json.choices?.[0];
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
      throw new BrowserGroqError(502, 'Groq returned a streaming response with no body');
    }

    const accumulator = new GroqStreamAccumulator();
    for await (const chunk of parseSseStream(response.body)) {
      // `accept` returns only the user-visible text: gpt-oss streams its chain
      // of thought in a sibling field, and forwarding that would print the
      // model's private reasoning into the answer.
      const text = accumulator.accept(chunk);
      if (text) onDelta(text);
    }

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

/** 131k context, reliable tool use, and the best writer Groq serves. */
export const DEFAULT_BROWSER_MODEL = 'openai/gpt-oss-120b';

/** A client when the visitor has supplied a key, null otherwise. */
export function buildBrowserLlm(): LlmClient | null {
  const stored = readModelKey();
  if (!stored) return null;
  return new BrowserGroqClient(stored.key, DEFAULT_BROWSER_MODEL);
}
