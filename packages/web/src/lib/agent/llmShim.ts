import type Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider } from '@server/config.js';

/**
 * The browser's replacement for the server's LLM client.
 *
 * `agent/llm.ts` loads the Anthropic SDK and reads `process.env`, so the static
 * build swaps this module in (see `vite.config.ts`). The Anthropic import above
 * is type-only and erases at build, so no SDK reaches the bundle.
 *
 * Two outcomes, decided per visitor rather than at build time:
 *
 *   - No key stored: `getLlm()` returns null, which is the orchestrator's own
 *     signal for deterministic mode. The agent still classifies the question,
 *     plans a toolchain, calls the same fourteen tools and grounds every
 *     figure; only the prose comes from templates.
 *   - A key the visitor supplied: a real Groq client, called straight from the
 *     browser. No key ships in the bundle - see `browserKey.ts` for why that
 *     distinction is the whole design.
 */

export interface LlmRequest {
  system: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  maxTokens?: number;
  /** Controls how hard the model thinks. `low` for classification, `high` for advice. */
  effort?: 'low' | 'medium' | 'high';
  toolChoice?: Anthropic.MessageCreateParams['tool_choice'];
}

export interface LlmClient {
  readonly provider: Exclude<LlmProvider, 'deterministic'>;
  readonly model: string;
  createMessage(params: LlmRequest): Promise<Anthropic.Message>;
  streamText(params: LlmRequest, onDelta: (text: string) => void): Promise<Anthropic.Message>;
}

/**
 * Resolved on every call rather than cached, because the visitor can connect or
 * disconnect a key between one question and the next and the following answer
 * must use what is stored now.
 */
export async function getLlm(): Promise<LlmClient | null> {
  const { buildBrowserLlm } = await import('./browserLlm');
  return buildBrowserLlm();
}

export function resetLlm(): void {
  /* Nothing is cached, so there is nothing to reset. */
}

/** Narrows a failure into something worth showing a user. */
export function describeLlmError(error: unknown): { message: string; recoverable: boolean } {
  const status = (error as { status?: number } | null)?.status;
  if (status === 429) {
    return {
      message:
        'Your Groq account is rate limited (the free tier allows 8,000 tokens a minute). Answering with the deterministic engine instead.',
      recoverable: true,
    };
  }
  if (status === 401 || status === 403) {
    return { message: 'That model key was rejected. Check it and connect again.', recoverable: false };
  }
  if (typeof status === 'number' && status >= 500) {
    return { message: `The model service returned an error (${status}).`, recoverable: true };
  }
  return {
    message: error instanceof Error ? error.message : 'Unknown reasoning failure',
    recoverable: false,
  };
}
