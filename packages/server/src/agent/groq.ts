import type Anthropic from '@anthropic-ai/sdk';
import { logger } from '../lib/logger.js';
import type { LlmRequest } from './llm.js';

/**
 * Groq, reached through its OpenAI-compatible Chat Completions endpoint.
 *
 * Groq serves open-weights models (gpt-oss, qwen) on their own inference
 * hardware. It is a third way to *narrate*: the finance engine, the tools and
 * the grounding verifier are identical whichever provider answers, so a faster
 * and cheaper model changes the prose and nothing else. That is the payoff of
 * keeping every number in `@wealth/shared` - swapping the writer cannot move a
 * figure.
 *
 * Everything here is a translation layer. The orchestrator speaks Anthropic
 * message shapes and must keep doing so, so this module converts in both
 * directions and hands back an `Anthropic.Message`. No SDK is involved: Groq's
 * wire format is plain JSON over `fetch`, so the Lambda bundle grows by nothing.
 *
 * The translation functions are exported separately from the client because the
 * wire mapping is the part that can silently rot, and it is testable without a
 * network or a key.
 */

/* -------------------------------------------------------------------------- */
/* Wire types - only the fields this integration actually reads                */
/* -------------------------------------------------------------------------- */

export interface GroqToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: GroqToolCall[];
  tool_call_id?: string;
}

export interface GroqPayload {
  model: string;
  messages: GroqMessage[];
  max_tokens: number;
  stream?: boolean;
  reasoning_effort?: 'low' | 'medium' | 'high';
  tools?: Array<{
    type: 'function';
    function: { name: string; description?: string; parameters: unknown };
  }>;
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
}

export interface GroqUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

/* -------------------------------------------------------------------------- */
/* Anthropic -> Groq                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `groq/compound` rejects this parameter outright with a 400, so support cannot
 * be assumed. An allowlist fails the safe way: an unknown model loses effort
 * control, where a denylist would lose the whole request.
 */
export function supportsReasoningEffort(model: string): boolean {
  return /gpt-oss|qwen3/i.test(model);
}

function systemText(system: LlmRequest['system']): string {
  if (typeof system === 'string') return system;
  // Anthropic cache_control markers are meaningless here and are dropped along
  // with the rest of the block wrapper.
  return system.map((block) => block.text).join('\n\n');
}

function blockText(content: Anthropic.ContentBlockParam[]): string {
  return content
    .filter((block): block is Anthropic.TextBlockParam => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** A tool_result's payload is a string here, but the type also allows blocks. */
function toolResultText(block: Anthropic.ToolResultBlockParam): string {
  if (typeof block.content === 'string') return block.content;
  if (!block.content) return '';
  return block.content
    .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Flattens Anthropic's block-structured conversation into OpenAI's message
 * list. The two disagree in one structural way that matters: Anthropic returns
 * every parallel tool result inside a single user message, OpenAI wants one
 * `role: "tool"` message per call. Order is preserved, so the assistant turn
 * carrying the `tool_calls` still immediately precedes its results.
 */
export function toGroqMessages(
  system: LlmRequest['system'],
  messages: Anthropic.MessageParam[],
): GroqMessage[] {
  const out: GroqMessage[] = [{ role: 'system', content: systemText(system) }];

  for (const message of messages) {
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    const blocks = message.content;

    if (message.role === 'assistant') {
      const toolUses = blocks.filter(
        (b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use',
      );
      const entry: GroqMessage = { role: 'assistant', content: blockText(blocks) };
      if (toolUses.length > 0) {
        entry.tool_calls = toolUses.map((use) => ({
          id: use.id,
          type: 'function' as const,
          function: { name: use.name, arguments: JSON.stringify(use.input ?? {}) },
        }));
      }
      out.push(entry);
      continue;
    }

    const toolResults = blocks.filter(
      (b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result',
    );
    const text = blockText(blocks);
    if (text) out.push({ role: 'user', content: text });
    for (const result of toolResults) {
      out.push({ role: 'tool', tool_call_id: result.tool_use_id, content: toolResultText(result) });
    }
  }

  return out;
}

export function toGroqTools(tools: Anthropic.Tool[] | undefined): GroqPayload['tools'] {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema,
    },
  }));
}

export function toGroqToolChoice(choice: LlmRequest['toolChoice']): GroqPayload['tool_choice'] {
  if (!choice) return undefined;
  switch (choice.type) {
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return { type: 'function', function: { name: choice.name } };
    default:
      return 'auto';
  }
}

/**
 * `maxTokensCap` is not a safety net, it is the point: Groq reserves the whole
 * of `max_tokens` against the account's per-minute allowance, so passing the
 * orchestrator's request straight through burns a small account's entire budget
 * on one call. Clamping keeps the request inside the allowance; the orchestrator
 * stays free to ask for what Claude would happily give.
 */
export function toGroqPayload(
  params: LlmRequest,
  model: string,
  stream: boolean,
  maxTokensCap: number,
): GroqPayload {
  const payload: GroqPayload = {
    model,
    messages: toGroqMessages(params.system, params.messages),
    max_tokens: Math.min(params.maxTokens ?? maxTokensCap, maxTokensCap),
    ...(stream ? { stream: true } : {}),
  };
  const tools = toGroqTools(params.tools);
  if (tools) payload.tools = tools;
  const toolChoice = toGroqToolChoice(params.toolChoice);
  if (toolChoice) payload.tool_choice = toolChoice;
  if (supportsReasoningEffort(model)) payload.reasoning_effort = params.effort ?? 'high';
  return payload;
}

/* -------------------------------------------------------------------------- */
/* Groq -> Anthropic                                                           */
/* -------------------------------------------------------------------------- */

/**
 * OpenAI-shaped finish reasons mapped onto Anthropic's. `content_filter`
 * becomes `refusal`, which the orchestrator already treats as "abandon this
 * turn and fall back" - a filtered turn can carry a truncated tool input, and
 * executing that is worse than answering deterministically.
 */
export function toStopReason(finish: string | null | undefined): Anthropic.StopReason {
  switch (finish) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    case 'stop':
    default:
      return 'end_turn';
  }
}

/**
 * Tool arguments arrive as a JSON *string*, and a smaller model will
 * occasionally emit one that does not parse. Falling back to `{}` hands the
 * tool an empty input, where its zod schema rejects it and the orchestrator
 * reports a tool error - a recoverable turn instead of a thrown request.
 */
export function parseToolArguments(raw: string, toolName: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    logger.warn('groq tool arguments were not a JSON object', { tool: toolName });
    return {};
  } catch {
    logger.warn('groq emitted unparseable tool arguments', {
      tool: toolName,
      preview: raw.slice(0, 120),
    });
    return {};
  }
}

/** Builds the `Anthropic.Message` the orchestrator expects, out of Groq's parts. */
export function toAnthropicMessage(args: {
  id: string;
  model: string;
  text: string;
  toolCalls: GroqToolCall[];
  finishReason: string | null | undefined;
  usage?: GroqUsage;
}): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = [];
  if (args.text) content.push({ type: 'text', text: args.text, citations: null });
  for (const call of args.toolCalls) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseToolArguments(call.function.arguments, call.function.name),
      caller: { type: 'direct' },
    });
  }

  // A model that emits tool calls but reports some other finish reason still
  // needs `tool_use`, or the orchestrator reads the turn as a final answer and
  // silently drops the calls.
  const stopReason: Anthropic.StopReason =
    args.toolCalls.length > 0 && args.finishReason !== 'content_filter'
      ? 'tool_use'
      : toStopReason(args.finishReason);

  return {
    id: args.id,
    type: 'message',
    role: 'assistant',
    model: args.model,
    content,
    container: null,
    stop_reason: stopReason,
    stop_details: null,
    stop_sequence: null,
    usage: {
      input_tokens: args.usage?.prompt_tokens ?? 0,
      output_tokens: args.usage?.completion_tokens ?? 0,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Retries                                                                     */
/* -------------------------------------------------------------------------- */

/** Transient by nature: the same request a moment later usually succeeds. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * A budget across the whole call, not a cap per attempt.
 *
 * What matters to someone watching a spinner is the total delay, not how it was
 * divided up, and a per-attempt cap bounds the wrong thing: two waits just under
 * it are worse than one just over. Measured against a free account, a mid-run
 * step asks for 9-10s, so a ceiling below that rejects exactly the retries worth
 * taking. Past the budget the deterministic engine answers instantly with the
 * same numbers, which beats holding the connection open any longer.
 */
const DEFAULT_RETRY_BUDGET_MS = 12_000;

/**
 * How long to wait before retrying, or `null` to give up and fall back.
 *
 * Groq is unusually helpful here: a 429 body carries the exact wait ("Please
 * try again in 1.38s"), and those waits are typically a second or two because
 * the token allowance refills continuously rather than on a fixed boundary. So
 * the hint is preferred over backoff whenever there is one - guessing would
 * either give up on a request that was about to succeed, or sit idle long
 * after the allowance returned.
 */
export function retryDelayMs(args: {
  status: number;
  retryAfter: string | null;
  detail: string;
  attempt: number;
  maxRetries: number;
  /** Milliseconds already spent waiting on earlier attempts in this call. */
  spentMs?: number;
  budgetMs?: number;
}): number | null {
  if (args.attempt >= args.maxRetries) return null;
  if (!RETRYABLE.has(args.status)) return null;

  // No hint: back off gently. 500ms, then 1s.
  const delay = hintedDelayMs(args.retryAfter, args.detail) ?? 500 * 2 ** args.attempt;

  const budget = args.budgetMs ?? DEFAULT_RETRY_BUDGET_MS;
  return (args.spentMs ?? 0) + delay > budget ? null : delay;
}

/** Reads the wait out of the `retry-after` header, else out of the message. */
function hintedDelayMs(retryAfter: string | null, detail: string): number | null {
  const header = Number.parseFloat(retryAfter ?? '');
  if (Number.isFinite(header) && header >= 0) return Math.ceil(header * 1000);

  const match = /try again in ([0-9]+(?:\.[0-9]+)?)\s*(ms|s)?/i.exec(detail);
  if (!match) return null;
  const value = Number.parseFloat(match[1] as string);
  if (!Number.isFinite(value)) return null;
  return match[2]?.toLowerCase() === 'ms' ? Math.ceil(value) : Math.ceil(value * 1000);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------------------------------------------------- */
/* Streaming                                                                   */
/* -------------------------------------------------------------------------- */

interface StreamDelta {
  content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }> | null;
}

/**
 * Accumulates an OpenAI-style streamed completion.
 *
 * Two details are load-bearing. Tool-call arguments may be split across any
 * number of chunks and are keyed by `index`, so they are concatenated rather
 * than overwritten. And gpt-oss streams its chain of thought in a separate
 * `reasoning` field alongside `content`: only `content` is ever handed back,
 * because whatever is handed back is streamed into the user's answer.
 */
export class GroqStreamAccumulator {
  text = '';
  finishReason: string | null = null;
  usage: GroqUsage | undefined;
  id = '';
  private readonly calls = new Map<number, GroqToolCall>();

  /** @returns the user-visible text in this chunk, if any. */
  accept(chunk: Record<string, any>): string {
    if (typeof chunk.id === 'string' && chunk.id) this.id = chunk.id;
    if (chunk.usage) this.usage = chunk.usage as GroqUsage;

    const choice = chunk.choices?.[0];
    if (!choice) return '';
    if (choice.finish_reason) this.finishReason = choice.finish_reason as string;

    const delta = (choice.delta ?? {}) as StreamDelta;

    for (const [i, fragment] of (delta.tool_calls ?? []).entries()) {
      const index = fragment.index ?? i;
      const existing = this.calls.get(index) ?? {
        id: '',
        type: 'function' as const,
        function: { name: '', arguments: '' },
      };
      if (fragment.id) existing.id = fragment.id;
      if (fragment.function?.name) existing.function.name = fragment.function.name;
      if (fragment.function?.arguments) existing.function.arguments += fragment.function.arguments;
      this.calls.set(index, existing);
    }

    const text = delta.content ?? '';
    if (text) this.text += text;
    return text;
  }

  toolCalls(): GroqToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call)
      // A fragment that never carried a name never became a real call; passing
      // it on would make the orchestrator look up a tool that does not exist.
      .filter((call) => call.function.name.length > 0);
  }
}

/**
 * Splits an SSE body into `data:` payloads. Network chunks do not align with
 * event boundaries, so the tail of a read is buffered until its newline arrives.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, any>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload) as Record<string, any>;
        } catch {
          logger.warn('groq stream emitted an unparseable chunk', {
            preview: payload.slice(0, 120),
          });
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
