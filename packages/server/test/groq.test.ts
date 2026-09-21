import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import {
  GroqStreamAccumulator,
  parseSseStream,
  parseToolArguments,
  retryDelayMs,
  supportsReasoningEffort,
  toAnthropicMessage,
  toGroqMessages,
  toGroqPayload,
  toGroqTools,
  toGroqToolChoice,
} from '../src/agent/groq.js';

/**
 * Groq wire-format tests.
 *
 * Groq is the one provider whose wire format is not Anthropic's, so a
 * translation layer sits between it and the orchestrator. That layer is the
 * part that can rot silently - a mapping can drift without throwing, and the
 * symptom is a dropped tool call or a leaked chain of thought rather than a
 * crash. All of it is pure, so none of this needs a key or a network.
 *
 * The expectations below were taken from real responses observed against
 * api.groq.com, not from the documentation.
 */

const SYSTEM: Anthropic.TextBlockParam[] = [
  { type: 'text', text: 'You are a planner.', cache_control: { type: 'ephemeral' } },
];

/* -------------------------------------------------------------------------- */
/* Anthropic -> Groq                                                           */
/* -------------------------------------------------------------------------- */

test('system blocks flatten to one system message and drop cache_control', () => {
  const messages = toGroqMessages(SYSTEM, [{ role: 'user', content: 'hello' }]);

  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { role: 'system', content: 'You are a planner.' });
  // cache_control is an Anthropic-only concept; leaking it would be a 400.
  assert.equal(JSON.stringify(messages).includes('cache_control'), false);
  assert.deepEqual(messages[1], { role: 'user', content: 'hello' });
});

test('assistant tool_use blocks become tool_calls with stringified arguments', () => {
  const messages = toGroqMessages('sys', [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'call_1', name: 'get_snapshot', input: { profileId: 'meera' } },
      ],
    },
  ]);

  const assistant = messages[1]!;
  assert.equal(assistant.role, 'assistant');
  assert.equal(assistant.content, 'Checking.');
  assert.equal(assistant.tool_calls?.length, 1);
  const call = assistant.tool_calls![0]!;
  assert.equal(call.function.name, 'get_snapshot');
  // OpenAI carries arguments as a JSON *string*, not an object.
  assert.equal(call.function.arguments, '{"profileId":"meera"}');
});

test('parallel tool results split into one tool message each, keyed to their call', () => {
  const messages = toGroqMessages('sys', [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_a', name: 'tool_a', input: {} },
        { type: 'tool_use', id: 'call_b', name: 'tool_b', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_a', content: 'result a' },
        { type: 'tool_result', tool_use_id: 'call_b', content: 'result b' },
      ],
    },
  ]);

  // Anthropic returns both results inside one user message; OpenAI wants one
  // `tool` message per call, still directly after the assistant turn.
  assert.deepEqual(
    messages.map((m) => m.role),
    ['system', 'assistant', 'tool', 'tool'],
  );
  assert.equal(messages[2]!.tool_call_id, 'call_a');
  assert.equal(messages[3]!.tool_call_id, 'call_b');
  assert.equal(messages[3]!.content, 'result b');

  // The ids must match the assistant turn, or Groq rejects the conversation.
  const callIds = messages[1]!.tool_calls?.map((c) => c.id);
  assert.deepEqual(callIds, ['call_a', 'call_b']);
});

test('tools map input_schema onto parameters', () => {
  const tools = toGroqTools([
    {
      name: 'project_goal',
      description: 'Project a goal.',
      input_schema: { type: 'object', properties: { goalId: { type: 'string' } } },
    } as Anthropic.Tool,
  ]);

  assert.equal(tools?.[0]!.type, 'function');
  assert.equal(tools?.[0]!.function.name, 'project_goal');
  assert.deepEqual(tools?.[0]!.function.parameters, {
    type: 'object',
    properties: { goalId: { type: 'string' } },
  });
});

test('tool_choice maps across the two vocabularies', () => {
  assert.equal(toGroqToolChoice(undefined), undefined);
  assert.equal(toGroqToolChoice({ type: 'auto' }), 'auto');
  assert.equal(toGroqToolChoice({ type: 'any' }), 'required');
  assert.equal(toGroqToolChoice({ type: 'none' }), 'none');
  assert.deepEqual(toGroqToolChoice({ type: 'tool', name: 'get_snapshot' }), {
    type: 'function',
    function: { name: 'get_snapshot' },
  });
});

test('reasoning_effort is sent only to models that accept it', () => {
  // Observed against the live API: groq/compound answers a request carrying
  // this parameter with `400 reasoning_effort is not supported with this model`.
  assert.equal(supportsReasoningEffort('openai/gpt-oss-120b'), true);
  assert.equal(supportsReasoningEffort('qwen/qwen3.8-27b'), true);
  assert.equal(supportsReasoningEffort('groq/compound'), false);

  const supported = toGroqPayload({ system: 'sys', messages: [], effort: 'low' }, 'openai/gpt-oss-120b', false, 1500);
  assert.equal(supported.reasoning_effort, 'low');

  const unsupported = toGroqPayload({ system: 'sys', messages: [], effort: 'low' }, 'groq/compound', false, 1500);
  assert.equal('reasoning_effort' in unsupported, false);
});

test('payload carries stream, and omits absent optionals', () => {
  const payload = toGroqPayload({ system: 'sys', messages: [] }, 'openai/gpt-oss-120b', true, 1500);

  assert.equal(payload.stream, true);
  assert.equal('tools' in payload, false);
  assert.equal('tool_choice' in payload, false);

  const nonStreaming = toGroqPayload({ system: 'sys', messages: [], maxTokens: 512 }, 'openai/gpt-oss-120b', false, 1500);
  assert.equal('stream' in nonStreaming, false);
  assert.equal(nonStreaming.max_tokens, 512);
});

test('the completion budget is clamped to what the account can afford', () => {
  // Groq reserves the whole of max_tokens against a per-minute allowance, so
  // the orchestrator's 8000 spends a free account's entire budget (8000/min)
  // on a single call and every request 429s before the model sees it.
  const clamped = toGroqPayload(
    { system: 'sys', messages: [], maxTokens: 8000 },
    'openai/gpt-oss-120b',
    true,
    1500,
  );
  assert.equal(clamped.max_tokens, 1500);

  // A request that already asks for less than the cap keeps its own figure.
  const modest = toGroqPayload(
    { system: 'sys', messages: [], maxTokens: 400 },
    'openai/gpt-oss-120b',
    true,
    1500,
  );
  assert.equal(modest.max_tokens, 400);

  // No explicit request falls back to the cap, never to the Anthropic default.
  const defaulted = toGroqPayload({ system: 'sys', messages: [] }, 'openai/gpt-oss-120b', true, 1500);
  assert.equal(defaulted.max_tokens, 1500);
});

/* -------------------------------------------------------------------------- */
/* Groq -> Anthropic                                                           */
/* -------------------------------------------------------------------------- */

test('unparseable tool arguments degrade to an empty object rather than throwing', () => {
  assert.deepEqual(parseToolArguments('{"realReturn":5}', 't'), { realReturn: 5 });
  assert.deepEqual(parseToolArguments('', 't'), {});
  assert.deepEqual(parseToolArguments('   ', 't'), {});
  // A smaller model can truncate or mangle its own JSON. The tool's zod schema
  // then rejects `{}` and the turn reports a tool error, which is recoverable;
  // throwing here would take down the whole request.
  assert.deepEqual(parseToolArguments('{"realReturn":', 't'), {});
  assert.deepEqual(parseToolArguments('[1,2]', 't'), {});
});

test('tool calls survive a finish_reason that does not mention them', () => {
  const message = toAnthropicMessage({
    id: 'chatcmpl-1',
    model: 'openai/gpt-oss-120b',
    text: '',
    toolCalls: [
      { id: 'fc_1', type: 'function', function: { name: 'get_snapshot', arguments: '{"a":1}' } },
    ],
    // Deliberately not 'tool_calls': if the stop reason were mapped naively the
    // orchestrator would read this turn as a final answer and drop the call.
    finishReason: 'stop',
  });

  assert.equal(message.stop_reason, 'tool_use');
  const block = message.content[0] as Anthropic.ToolUseBlock;
  assert.equal(block.type, 'tool_use');
  assert.equal(block.id, 'fc_1');
  assert.equal(block.name, 'get_snapshot');
  assert.deepEqual(block.input, { a: 1 });
});

test('a filtered turn is reported as a refusal even when it carries tool calls', () => {
  const message = toAnthropicMessage({
    id: 'chatcmpl-2',
    model: 'openai/gpt-oss-120b',
    text: '',
    toolCalls: [{ id: 'fc_1', type: 'function', function: { name: 'x', arguments: '{}' } }],
    finishReason: 'content_filter',
  });

  // The orchestrator abandons the turn on a refusal. A filtered response can
  // carry a truncated tool input, so executing it would be worse than falling
  // back to the deterministic engine.
  assert.equal(message.stop_reason, 'refusal');
});

test('finish reasons and usage map onto the Anthropic shape', () => {
  const plain = toAnthropicMessage({
    id: 'chatcmpl-3',
    model: 'openai/gpt-oss-120b',
    text: 'Your corpus is on track.',
    toolCalls: [],
    finishReason: 'stop',
    usage: { prompt_tokens: 155, completion_tokens: 161 },
  });

  assert.equal(plain.type, 'message');
  assert.equal(plain.role, 'assistant');
  assert.equal(plain.stop_reason, 'end_turn');
  assert.equal(plain.usage.input_tokens, 155);
  assert.equal(plain.usage.output_tokens, 161);
  assert.deepEqual(
    plain.content.map((b) => b.type),
    ['text'],
  );

  const truncated = toAnthropicMessage({
    id: 'chatcmpl-4',
    model: 'openai/gpt-oss-120b',
    text: 'partial',
    toolCalls: [],
    finishReason: 'length',
  });
  assert.equal(truncated.stop_reason, 'max_tokens');
  // Absent usage must not produce NaN in the logs.
  assert.equal(truncated.usage.input_tokens, 0);
});

/* -------------------------------------------------------------------------- */
/* Streaming                                                                   */
/* -------------------------------------------------------------------------- */

test('the reasoning channel is accumulated but never handed back as answer text', () => {
  const accumulator = new GroqStreamAccumulator();

  // This is the real gpt-oss delta shape: chain of thought arrives in its own
  // field, alongside the user-facing content.
  const hidden = accumulator.accept({
    id: 'chatcmpl-5',
    choices: [{ delta: { reasoning: 'We need to call the tool', channel: 'analysis' } }],
  });
  const shown = accumulator.accept({ choices: [{ delta: { content: 'Your corpus' } }] });

  assert.equal(hidden, '');
  assert.equal(shown, 'Your corpus');
  assert.equal(accumulator.text, 'Your corpus');
  // Anything returned here is streamed straight into the user's answer, so the
  // model's private reasoning must never appear in it.
  assert.equal(accumulator.text.includes('We need to'), false);
  assert.equal(accumulator.id, 'chatcmpl-5');
});

test('tool-call arguments are concatenated across chunks and keyed by index', () => {
  const accumulator = new GroqStreamAccumulator();

  accumulator.accept({
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'fc_1', function: { name: 'project_goal' } }] } }],
  });
  accumulator.accept({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"goalId":' } }] } }] });
  accumulator.accept({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"retire"}' } }] } }] });
  accumulator.accept({
    choices: [{ delta: { tool_calls: [{ index: 1, id: 'fc_2', function: { name: 'run_sim', arguments: '{}' } }] } }],
  });
  accumulator.accept({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });

  const calls = accumulator.toolCalls();
  assert.equal(calls.length, 2);
  // Fragments overwritten instead of appended would leave `"retire"}` here.
  assert.equal(calls[0]!.function.arguments, '{"goalId":"retire"}');
  assert.equal(calls[0]!.id, 'fc_1');
  assert.equal(calls[1]!.function.name, 'run_sim');
  assert.equal(accumulator.finishReason, 'tool_calls');
});

test('a fragment that never carried a tool name is discarded', () => {
  const accumulator = new GroqStreamAccumulator();
  accumulator.accept({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] });

  // Passing this on would send the orchestrator looking up a nameless tool.
  assert.deepEqual(accumulator.toolCalls(), []);
});

test('SSE parsing survives events split across network chunks', async () => {
  // Reads do not align with event boundaries; the tail has to be buffered.
  const raw = [
    'data: {"id":"chatcmpl-6","choi',
    'ces":[{"delta":{"content":"Hel"}}]}\ndata: {"choices":[{"delta":{"content":"lo"},',
    '"finish_reason":"stop"}]}\n',
    'data: [DONE]\n',
    'data: {"choices":[{"delta":{"content":" ignored"}}]}\n',
  ];
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of raw) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  const accumulator = new GroqStreamAccumulator();
  for await (const chunk of parseSseStream(body)) accumulator.accept(chunk);

  assert.equal(accumulator.text, 'Hello');
  assert.equal(accumulator.id, 'chatcmpl-6');
  assert.equal(accumulator.finishReason, 'stop');
});

test('a malformed chunk is skipped without ending the stream', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n'));
      controller.enqueue(encoder.encode('data: {not json\n'));
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"b"}}]}\n'));
      controller.enqueue(encoder.encode('data: [DONE]\n'));
      controller.close();
    },
  });

  const accumulator = new GroqStreamAccumulator();
  for await (const chunk of parseSseStream(body)) accumulator.accept(chunk);

  // Losing one chunk should cost one token of prose, not the whole answer.
  assert.equal(accumulator.text, 'ab');
});

/* -------------------------------------------------------------------------- */
/* Retries                                                                     */
/* -------------------------------------------------------------------------- */

const RETRY = { attempt: 0, maxRetries: 2 };

test('a rate limit is retried using the wait Groq names in the body', () => {
  // Groq states the exact wait, and it is usually a second or two: the token
  // allowance refills continuously rather than on a fixed boundary. Guessing
  // instead would abandon a request that was about to succeed.
  const detail =
    'Rate limit reached for model `openai/gpt-oss-120b` ... on tokens per minute (TPM): ' +
    'Limit 8000, Used 5169, Requested 3015. Please try again in 1.38s.';

  assert.equal(retryDelayMs({ ...RETRY, status: 429, retryAfter: null, detail }), 1380);
});

test('the retry-after header wins over the message', () => {
  const delay = retryDelayMs({
    ...RETRY,
    status: 429,
    retryAfter: '2',
    detail: 'Please try again in 30s.',
  });
  assert.equal(delay, 2000);
});

test('a wait longer than the ceiling is not worth taking', () => {
  // The deterministic engine answers instantly with the same numbers, so
  // sitting on a held connection for half a minute serves nobody.
  const delay = retryDelayMs({
    ...RETRY,
    status: 429,
    retryAfter: null,
    detail: 'Please try again in 42s.',
  });
  assert.equal(delay, null);
});

test('retries are bounded, and only transient failures qualify', () => {
  const detail = "Please try again in 1s.";

  // The last allowed attempt still retries; the one after it gives up.
  assert.equal(
    retryDelayMs({ status: 429, retryAfter: null, detail, attempt: 1, maxRetries: 2 }),
    1000,
  );
  assert.equal(
    retryDelayMs({ status: 429, retryAfter: null, detail, attempt: 2, maxRetries: 2 }),
    null,
  );

  // A rejected request is not going to succeed by being sent again.
  assert.equal(retryDelayMs({ ...RETRY, status: 400, retryAfter: null, detail: '' }), null);
  assert.equal(retryDelayMs({ ...RETRY, status: 401, retryAfter: null, detail: '' }), null);

  // A server-side blip is.
  assert.equal(retryDelayMs({ ...RETRY, status: 503, retryAfter: null, detail: '' }), 500);
});

test('an unhinted failure backs off instead of hammering', () => {
  assert.equal(retryDelayMs({ status: 500, retryAfter: null, detail: '', attempt: 0, maxRetries: 2 }), 500);
  assert.equal(retryDelayMs({ status: 500, retryAfter: null, detail: '', attempt: 1, maxRetries: 2 }), 1000);
});

test('the wait a free account actually asks for is taken, not refused', () => {
  // Measured against api.groq.com: a mid-run step on the free tier is told to
  // wait 9-10s, because the token allowance refills continuously. An earlier
  // 8s ceiling rejected exactly these - the retries most worth taking.
  const delay = retryDelayMs({
    ...RETRY,
    status: 429,
    retryAfter: null,
    detail: 'Limit 8000, Used 5758, Requested 3558. Please try again in 9.87s.',
  });
  assert.equal(delay, 9870);
});

test('the budget covers the whole call, not each attempt separately', () => {
  // Two waits just inside a per-attempt cap are worse for the person watching
  // a spinner than one wait just outside it, so the limit is cumulative.
  const detail = 'Please try again in 7s.';

  const first = retryDelayMs({ ...RETRY, status: 429, retryAfter: null, detail, spentMs: 0 });
  assert.equal(first, 7000);

  const second = retryDelayMs({
    status: 429,
    retryAfter: null,
    detail,
    attempt: 1,
    maxRetries: 2,
    spentMs: 7000,
  });
  assert.equal(second, null, "14s total exceeds the 12s budget");
});

test('the budget is configurable', () => {
  const args = {
    ...RETRY,
    status: 429,
    retryAfter: null,
    detail: 'Please try again in 9s.',
  };
  assert.equal(retryDelayMs({ ...args, budgetMs: 20_000 }), 9000);
  assert.equal(retryDelayMs({ ...args, budgetMs: 5_000 }), null);
});
