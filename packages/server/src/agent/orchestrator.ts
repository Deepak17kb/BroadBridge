import type Anthropic from '@anthropic-ai/sdk';
import {
  buildSnapshot,
  formatCompact,
  type AgentAttachment,
  type AgentEvent,
  type AgentMessage,
  type AgentPlanStep,
  type Assumption,
  type Citation,
  type UserProfile,
} from '@wealth/shared';
import { type AppConfig, config } from '../config.js';
import { logger } from '../lib/logger.js';
import { classifyIntent, heuristicPlan, heuristicToolInput, type Intent } from './intent.js';
import { retrieve } from './knowledge/retriever.js';
import { describeLlmError, getLlm } from './llm.js';
import { composeDeterministicAnswer } from './synthesis.js';
import { executeTool, TOOL_MAP, toolSchemas, type ToolContext, type ToolResult } from './tools.js';
import { groundingRatio, verifyAnswer } from './verifier.js';

/**
 * The agent workflow.
 *
 *   1. PLAN      - classify the request and publish a plan of tool calls
 *   2. ACT       - run the tools, feeding results back to the model
 *   3. SYNTHESIZE- write the answer, streamed token by token
 *   4. VERIFY    - check every figure in the answer against tool output
 *
 * Steps 1-4 all emit events over SSE, so the user watches the reasoning happen
 * instead of waiting on a spinner. The loop is written by hand rather than with
 * the SDK's tool runner because each phase has to be narrated to the client and
 * the plan has to be revised as tools return.
 *
 * The whole workflow runs with or without an LLM. Without one, the planner is
 * the intent router and the synthesiser is a template over the same tool
 * outputs - every feature still works, the prose is just less fluent.
 */

const SYSTEM_PROMPT = `You are the AI Wealth Navigator, a financial wellness assistant.

## What you are
You help one specific user understand their money, explore what-if scenarios and decide what to do next. You have tools that read their real position and run the platform's financial engine.

## Absolute rules
1. NEVER calculate a financial figure yourself. Every number in your answer must come from a tool result in this conversation. If you need a number you do not have, call a tool. Arithmetic done in your head is a bug.
2. Call get_financial_snapshot before answering anything about this user's position. Generic advice given without reading their numbers is a failure, however sensible it sounds.
3. Make assumptions visible. When a projection rests on an assumed return, inflation rate or savings rate, say so in the answer.
4. Never claim certainty about markets. Use ranges and probabilities, which the tools give you.
5. You are not a licensed adviser and the data is synthetic. If the user asks for a product recommendation, a specific security, or tax filing advice, explain the principle and tell them to confirm specifics with a qualified professional. Do not name specific funds or stocks to buy.

## How to answer
- Lead with the answer. The user asked a question; the first sentence should answer it.
- Plain language. No jargon without a short gloss: say "how much your portfolio swings around (volatility)".
- Be specific with their numbers, not generic. "Your 1.3 months of emergency cover" beats "you should have an emergency fund".
- Quantify the trade-off. Every recommendation costs something - name it.
- Respect the planning waterfall: protection, then expensive debt, then goals, then optimisation. Never advise investing surplus while a 40% credit-card balance sits outstanding.
- Length: 120-220 words for most questions. Use short paragraphs, and a compact list only when there are genuinely parallel items.
- Close with one concrete next step, unless the user only asked for an explanation.
- If the question cannot be answered from the tools, say what is missing rather than guessing.

## Formatting
Write amounts the way the tools return them (₹1.25 Cr, ₹45,000). Never invent a more precise figure than the tool gave you.`;

export interface RunAgentOptions {
  profile: UserProfile;
  message: string;
  /** Prior turns, for follow-up questions. */
  history?: AgentMessage[];
  emit: (event: AgentEvent) => void;
  onProfileChange?: (profile: UserProfile) => void;
  signal?: AbortSignal;
}

interface ToolRun {
  tool: string;
  label: string;
  ms: number;
  result: ToolResult;
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentMessage> {
  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const started = Date.now();
  opts.emit({ type: 'run_started', runId, at: new Date().toISOString() });

  const { intent, confidence } = classifyIntent(opts.message);
  let profile = opts.profile;
  const ctx: ToolContext = {
    profile,
    onProfileChange: (updated) => {
      profile = updated;
      ctx.profile = updated;
      opts.onProfileChange?.(updated);
    },
  };

  const plan = heuristicPlan(intent);
  opts.emit({
    type: 'plan',
    steps: plan,
    rationale: planRationale(intent, confidence),
  });

  const runs: ToolRun[] = [];
  const citations: Citation[] = [];
  const attachments: AgentAttachment[] = [];

  const llm = await getLlm();

  try {
    if (llm) {
      const answer = await runWithModel({ ...opts, ctx, plan, runs, citations, attachments, llm, intent });
      return answer;
    }
    const answer = await runDeterministic({ ...opts, ctx, plan, runs, citations, attachments, intent });
    return answer;
  } catch (error) {
    const described = describeLlmError(error);
    // The raw error stays in the log; only the described message reaches the client.
    logger.error('agent run failed', {
      runId,
      message: described.message,
      cause: error instanceof Error ? error.message : String(error),
    });
    opts.emit({ type: 'error', message: described.message, recoverable: described.recoverable });

    // A model failure must not lose the work already done - fall back to the
    // deterministic synthesiser over whatever tool results we have.
    try {
      const answer = await runDeterministic({
        ...opts,
        ctx,
        plan,
        runs,
        citations,
        attachments,
        intent,
        degraded: true,
      });
      return answer;
    } catch (fallbackError) {
      const message = buildMessage({
        content:
          'I could not complete that request. The financial engine is available but the reasoning service failed - please try again.',
        runs,
        citations,
        attachments,
        plan,
        verification: [],
        engine: 'deterministic',
      });
      opts.emit({ type: 'final', message });
      logger.error('deterministic fallback also failed', {
        runId,
        message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
      return message;
    }
  } finally {
    logger.info('agent run complete', {
      runId,
      intent,
      ms: Date.now() - started,
      tools: runs.map((r) => r.tool),
      engine: llm?.provider ?? 'deterministic',
    });
  }
}

function planRationale(intent: Intent, confidence: number): string {
  const map: Record<Intent, string> = {
    overview: 'Reading the full position, then ranking what matters most.',
    goal: 'Projecting the goal to its target date, then stress-testing it against market variability.',
    whatif: 'Running the scenario through the planning engine and comparing it against the current plan.',
    compare: 'Running each option through the engine so they can be ranked on the same basis.',
    probability: 'Simulating thousands of market paths to get a probability rather than a single guess.',
    portfolio: 'Analysing the holdings, then deriving the target mix for this risk profile and horizon.',
    actions: 'Scoring every available action by impact, effort and urgency.',
    debt: 'Comparing payoff strategies and checking the debt-versus-investing trade-off.',
    education: 'Looking up the principle, then applying it to this user’s own numbers.',
    update: 'Applying the requested change, then re-scoring the plan.',
  };
  const detail = map[intent];
  return confidence < 0.5
    ? `${detail} (Request was ambiguous, so the plan starts broad and narrows once the position is read.)`
    : detail;
}

/* -------------------------------------------------------------------------- */
/* Shared plumbing                                                             */
/* -------------------------------------------------------------------------- */

interface PhaseArgs extends RunAgentOptions {
  ctx: ToolContext;
  plan: AgentPlanStep[];
  runs: ToolRun[];
  citations: Citation[];
  attachments: AgentAttachment[];
  intent: Intent;
}

/** Runs one tool, narrates it, and records everything needed for verification. */
async function callTool(
  args: PhaseArgs,
  tool: string,
  input: unknown,
  callId: string,
): Promise<ToolResult> {
  const label = labelFor(tool) ?? `Running ${tool.replace(/_/g, ' ')}`;

  args.emit({ type: 'tool_call', id: callId, tool, input, label });
  const startedAt = Date.now();
  let result: ToolResult;
  try {
    result = await executeTool(tool, input, args.ctx);
  } catch (error) {
    // A single tool failure is recoverable - report it and let the model or the
    // template work with what it has.
    const message = error instanceof Error ? error.message : String(error);
    logger.error('tool failed', { tool, message });
    result = {
      summary: `Tool ${tool} failed: ${message}`,
      data: { error: 'tool_failed', message },
      facts: {},
    };
  }
  const ms = Date.now() - startedAt;

  args.emit({ type: 'tool_result', id: callId, tool, summary: result.summary, data: result.data, ms });
  args.runs.push({ tool, label, ms, result });

  if (result.attachment) args.attachments.push(result.attachment);

  // Knowledge lookups become citations and a dedicated retrieval event.
  if (tool === 'search_knowledge' && Array.isArray(result.data)) {
    const hits = result.data as { id: string; title: string; score: number; snippet: string }[];
    args.emit({
      type: 'retrieval',
      query: String((input as { query?: string })?.query ?? ''),
      hits: hits.map((h) => ({ title: h.title, score: h.score, snippet: h.snippet })),
    });
    for (const hit of hits) {
      if (!args.citations.some((c) => c.ref === hit.id)) {
        args.citations.push({ kind: 'knowledge', ref: hit.id, label: hit.title });
      }
    }
  } else if (!args.citations.some((c) => c.ref === tool)) {
    args.citations.push({ kind: 'tool', ref: tool, label });
  }

  return result;
}

/**
 * The trace label a tool declares for itself. This was a second, hand-kept
 * list that had drifted: the two newest tools were missing from it and showed
 * in the trace as "Running estimate action impact".
 */
function labelFor(tool: string): string | undefined {
  return TOOL_MAP.get(tool)?.label;
}

/** Union of every number the tools produced, for the verifier. */
function collectFacts(runs: ToolRun[]): Record<string, number> {
  const facts: Record<string, number> = {};
  for (const run of runs) Object.assign(facts, run.result.facts);
  return facts;
}

/** Assumptions surfaced by the engine, de-duplicated for display. */
function collectAssumptions(runs: ToolRun[], profile: UserProfile): Assumption[] {
  const out: Assumption[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    const data = run.result.data as { assumptions?: Assumption[] } | undefined;
    const list = Array.isArray(data?.assumptions) ? data.assumptions : [];
    for (const assumption of list) {
      const key = `${assumption.label}|${assumption.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(assumption);
    }
  }
  if (out.length === 0) {
    const snapshot = buildSnapshot(profile);
    out.push(
      {
        label: 'Inflation',
        value: `${(snapshot.assumptions.inflationPct * 100).toFixed(1)}%/yr`,
        source: 'market_assumption',
      },
      {
        label: 'Data',
        value: 'Synthetic profile - illustrative only, not financial advice',
        source: 'model_default',
      },
    );
  }
  return out.slice(0, 10);
}

function buildMessage(args: {
  content: string;
  runs: ToolRun[];
  citations: Citation[];
  attachments: AgentAttachment[];
  plan: AgentPlanStep[];
  verification: AgentMessage['verification'];
  engine: AgentMessage['engine'];
  profile?: UserProfile;
}): AgentMessage {
  return {
    id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    role: 'assistant',
    content: args.content,
    at: new Date().toISOString(),
    citations: args.citations,
    assumptions: args.profile ? collectAssumptions(args.runs, args.profile) : undefined,
    plan: args.plan,
    toolCalls: args.runs.map((r) => ({ tool: r.tool, label: r.label, ms: r.ms })),
    verification: args.verification,
    attachments: args.attachments,
    engine: args.engine,
  };
}

/* -------------------------------------------------------------------------- */
/* LLM path                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Tools every answer may need whatever the plan says: rule 2 of the system
 * prompt obliges the model to read the position before answering, and grounding
 * an explanation in a principle is always in bounds.
 */
const ALWAYS_OFFERED = ['get_financial_snapshot', 'search_knowledge'] as const;

/**
 * The tools to put in front of the model this run.
 *
 * Under `agentToolScope: 'plan'` that is the router's chosen toolchain plus
 * ALWAYS_OFFERED - typically four schemas rather than fourteen, which is the
 * difference between a question fitting inside a free Groq account's per-minute
 * allowance and running out of it mid-run. The plan's `synthesize` step names
 * no tool and is dropped by `toolSchemas`, which ignores unknown names.
 *
 * The model can still decline the plan; it simply chooses from a shortlist the
 * router picked for this intent rather than from everything the platform owns.
 */
export function offeredTools(
  plan: AgentPlanStep[],
  scope: AppConfig['agentToolScope'] = config.agentToolScope,
): Anthropic.Tool[] {
  if (scope === 'all') return toolSchemas();
  return toolSchemas([...new Set([...ALWAYS_OFFERED, ...plan.map((step) => step.tool)])]);
}

async function runWithModel(
  args: PhaseArgs & { llm: NonNullable<Awaited<ReturnType<typeof getLlm>>> },
): Promise<AgentMessage> {
  const { llm } = args;
  const tools = offeredTools(args.plan);

  // The user's position is injected up front. It costs a few hundred tokens and
  // removes an entire round-trip for the common case where the model would
  // immediately call get_financial_snapshot anyway.
  const snapshot = buildSnapshot(args.ctx.profile);
  const contextBlock = [
    `User: ${args.ctx.profile.displayName}, age ${args.ctx.profile.age}, retiring at ${args.ctx.profile.retirementAge}, ${args.ctx.profile.dependents} dependent(s), currency ${args.ctx.profile.currency}.`,
    `Position: net worth ${formatCompact(snapshot.netWorth.netWorth, args.ctx.profile.currency)}, monthly surplus ${formatCompact(snapshot.cashflow.monthlySurplus, args.ctx.profile.currency)}, emergency cover ${snapshot.cashflow.emergencyFundMonths} months, risk profile ${snapshot.risk.bucket}, wellness ${snapshot.wellness.total}/100.`,
    `Goals: ${snapshot.goalProjections.map((g) => `${g.goalName} (${(g.fundedRatio * 100).toFixed(0)}% funded, ${g.yearsToGoal.toFixed(1)}y away)`).join('; ') || 'none set'}.`,
    `Planner's intent classification: ${args.intent}. Suggested toolchain: ${args.plan.filter((s) => s.tool !== 'synthesize').map((s) => s.tool).join(' -> ')}. You may deviate if the question warrants it.`,
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
  ].join('\n');

  const messages: Anthropic.MessageParam[] = [
    ...historyToMessages(args.history ?? []),
    { role: 'user', content: `${contextBlock}\n\n---\n\nUser's question: ${args.message}` },
  ];

  let step = 0;
  let finalText = '';

  while (step < config.maxAgentSteps) {
    step += 1;
    if (args.signal?.aborted) throw new Error('Request aborted by client');

    let streamed = '';
    const response = await llm.streamText(
      {
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages,
        tools,
        maxTokens: 8000,
        // The opening turn has one decision in it - which tool to read the
        // position with - and the system prompt has already made it. On a
        // reasoning model the chain of thought is billed as completion, so
        // thinking hard here is paid for out of the same per-minute allowance
        // the answer needs. Every later turn, tool-picking and narration
        // alike, gets the full setting.
        effort: step === 1 ? 'low' : 'high',
      },
      (delta) => {
        streamed += delta;
        args.emit({ type: 'token', text: delta });
      },
    );

    // A refusal can truncate a tool input mid-stream; never execute that turn.
    if (response.stop_reason === 'refusal') {
      args.emit({
        type: 'thought',
        text: 'The reasoning service declined this request. Falling back to the deterministic engine.',
      });
      throw new Error('Reasoning service refused the request');
    }

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    if (toolUses.length === 0 || response.stop_reason === 'end_turn') {
      finalText =
        streamed.trim() ||
        response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    // Parallel tool calls must come back as tool_result blocks in ONE user
    // message; splitting them teaches the model to stop calling in parallel.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      markPlanStep(args, use.name, 'running');
      const result = await callTool(args, use.name, use.input, use.id);
      markPlanStep(args, use.name, 'done');
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        // The summary is what the model reasons over; the full payload goes to
        // the UI. Feeding back entire Monte Carlo band arrays would burn the
        // context window on data the model cannot use.
        content: result.summary,
      });
    }
    messages.push({ role: 'user', content: results });
  }

  if (!finalText) {
    // Hit the step ceiling. Ask for a wrap-up with tools switched off rather
    // than returning nothing.
    args.emit({
      type: 'thought',
      text: `Reached the ${config.maxAgentSteps}-step limit - summarising what the tools returned.`,
    });
    const closing = await llm.streamText(
      {
        system: SYSTEM_PROMPT,
        messages: [
          ...messages,
          {
            role: 'user',
            content:
              'You have run out of tool budget. Answer the original question now using only the tool results above. Do not request more tools.',
          },
        ],
        maxTokens: 2000,
        effort: 'medium',
      },
      (delta) => args.emit({ type: 'token', text: delta }),
    );
    finalText = closing.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }

  const verification = verifyAnswer(finalText, collectFacts(args.runs));
  args.emit({ type: 'verification', checks: verification });
  const ratio = groundingRatio(verification);
  if (ratio < 0.7 && verification.length > 2) {
    logger.warn('answer had weak grounding', { ratio, claims: verification.length });
  }

  const message = buildMessage({
    content: finalText,
    runs: args.runs,
    citations: args.citations,
    attachments: args.attachments,
    plan: args.plan,
    verification,
    engine: llm.provider,
    profile: args.ctx.profile,
  });
  args.emit({ type: 'final', message });
  return message;
}

function markPlanStep(args: PhaseArgs, tool: string, status: AgentPlanStep['status']): void {
  const step = args.plan.find((s) => s.tool === tool && s.status !== 'done');
  if (step) {
    step.status = status;
  } else if (status === 'running') {
    // The model chose a tool the planner did not anticipate - show it anyway,
    // so the trace always reflects what actually ran.
    args.plan.push({
      id: `${tool}-${Math.random().toString(36).slice(2, 8)}`,
      tool,
      goal: labelFor(tool) ?? `Run ${tool}`,
      status: 'running',
    });
  }
  args.emit({ type: 'plan', steps: args.plan, rationale: planRationale(args.intent, 1) });
}

function historyToMessages(history: AgentMessage[]): Anthropic.MessageParam[] {
  // Only the last few turns are replayed - the position is re-injected fresh
  // each turn, so older transcript adds tokens without adding accuracy.
  return history
    .slice(-6)
    .filter((m) => m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }));
}

/* -------------------------------------------------------------------------- */
/* Deterministic path                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Executes the heuristic plan and composes the answer from templates.
 *
 * This is not a stub. It runs the same tools in the same order and produces a
 * grounded, specific answer - it just cannot rephrase itself or handle an
 * unanticipated question as gracefully as the model can.
 */
async function runDeterministic(args: PhaseArgs & { degraded?: boolean }): Promise<AgentMessage> {
  const alreadyRun = new Set(args.runs.map((r) => r.tool));

  for (const step of args.plan) {
    if (step.tool === 'synthesize') continue;
    if (alreadyRun.has(step.tool)) {
      step.status = 'done';
      continue;
    }
    step.status = 'running';
    args.emit({ type: 'plan', steps: args.plan, rationale: planRationale(args.intent, 1) });

    const input = heuristicToolInput(step.tool, args.intent, args.message, args.ctx.profile);
    const result = await callTool(args, step.tool, input, step.id);
    alreadyRun.add(step.tool);
    step.status = (result.data as { error?: string })?.error ? 'failed' : 'done';
  }
  args.emit({ type: 'plan', steps: args.plan, rationale: planRationale(args.intent, 1) });

  // Add supporting knowledge even when the plan did not ask for it, so the
  // answer can always say *why*.
  if (!alreadyRun.has('search_knowledge')) {
    const hits = retrieve(args.message, 1);
    if (hits.length > 0 && hits[0]) {
      args.citations.push({ kind: 'knowledge', ref: hits[0].id, label: hits[0].title });
    }
  }

  const content = composeDeterministicAnswer({
    intent: args.intent,
    message: args.message,
    profile: args.ctx.profile,
    runs: args.runs.map((r) => ({ tool: r.tool, result: r.result })),
    degraded: args.degraded ?? false,
  });

  const verification = verifyAnswer(content, collectFacts(args.runs));
  args.emit({ type: 'verification', checks: verification });

  const message = buildMessage({
    content,
    runs: args.runs,
    citations: args.citations,
    attachments: args.attachments,
    plan: args.plan,
    verification,
    engine: 'deterministic',
    profile: args.ctx.profile,
  });
  args.emit({ type: 'final', message });
  return message;
}
