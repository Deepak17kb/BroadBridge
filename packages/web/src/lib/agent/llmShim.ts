/**
 * The browser's stand-in for the server's LLM client.
 *
 * `agent/llm.ts` loads the Anthropic SDK and reaches the network, neither of
 * which belongs in a public bundle: a model needs a key, and a key shipped to
 * the browser is a key anyone can read out of DevTools. So the static build
 * swaps this module in (see `vite.config.ts`) and `getLlm()` always answers
 * null.
 *
 * Null is not a failure here. It is the orchestrator's documented signal for
 * deterministic mode, and that mode is the whole point: the agent still
 * classifies the question, plans a toolchain, calls the same fourteen tools
 * against the same finance engine, retrieves from the same knowledge base and
 * grounds every figure it prints. Only the prose comes from templates rather
 * than from a model.
 */

import type { LlmProvider } from '../../../../server/src/config.js';

/** Mirrors the server's `LlmRequest` so the orchestrator's types line up. */
export interface LlmRequest {
  system: string | unknown[];
  messages: unknown[];
  tools?: unknown[];
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  toolChoice?: unknown;
}

export interface LlmClient {
  readonly provider: Exclude<LlmProvider, 'deterministic'>;
  readonly model: string;
  createMessage(params: LlmRequest): Promise<never>;
  streamText(params: LlmRequest, onDelta: (text: string) => void): Promise<never>;
}

/** Always null in the browser: deterministic mode, by construction. */
export async function getLlm(): Promise<LlmClient | null> {
  return null;
}

export function resetLlm(): void {
  /* Nothing is cached, because nothing is ever built. */
}

/**
 * Kept so the orchestrator's error path still type-checks and still behaves.
 * It is unreachable while `getLlm()` returns null - there is no model call to
 * fail - but an unreachable branch that throws is worse than one that answers.
 */
export function describeLlmError(error: unknown): { message: string; recoverable: boolean } {
  return {
    message: error instanceof Error ? error.message : 'Unknown reasoning failure',
    recoverable: false,
  };
}
