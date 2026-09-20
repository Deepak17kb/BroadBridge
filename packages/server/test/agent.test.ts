import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PERSONAS } from '@wealth/shared';
import { createApp } from '../src/app.js';
import { classifyIntent, heuristicPlan, inferLevers } from '../src/agent/intent.js';
import { retrieve } from '../src/agent/knowledge/retriever.js';
import { executeTool } from '../src/agent/tools.js';
import { extractClaims, groundingRatio, verifyAnswer } from '../src/agent/verifier.js';

/**
 * Agent tests.
 *
 * These run in deterministic mode (no credentials in CI), which is exactly the
 * path that must never break: it is the fallback behind every LLM failure, so
 * its correctness is a reliability property of the whole product.
 */

let server: Server;
let baseUrl: string;
const meera = PERSONAS.find((p) => p.id === 'meera')!.profile;

/** `Response.json()` is typed `unknown`; these tests assert on shapes they own. */
async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/* -------------------------------------------------------------------------- */
/* Intent routing                                                              */
/* -------------------------------------------------------------------------- */

test('intents route to the right toolchain', () => {
  const cases: [string, string][] = [
    ['How am I doing overall?', 'overview'],
    ['What if I save 10000 more every month?', 'whatif'],
    ['Am I on track for my retirement?', 'goal'],
    ['Should I pay off my credit card or invest?', 'debt'],
    ['Is my portfolio too risky? Should I rebalance?', 'portfolio'],
    ['What should I do next?', 'actions'],
    ['What are the chances I actually hit my target?', 'probability'],
    ['Why do you keep telling me to build an emergency fund?', 'education'],
    ['Which is better, saving more or working two more years?', 'compare'],
  ];
  for (const [message, expected] of cases) {
    const { intent } = classifyIntent(message);
    assert.equal(intent, expected, `"${message}" should route to ${expected}, got ${intent}`);
  }
});

test('every plan starts by reading the real position and ends by synthesising', () => {
  for (const intent of ['overview', 'goal', 'whatif', 'portfolio', 'actions', 'debt'] as const) {
    const plan = heuristicPlan(intent);
    assert.ok(
      plan.some((s) => s.tool === 'get_financial_snapshot'),
      `${intent} must read the position`,
    );
    assert.equal(plan.at(-1)?.tool, 'synthesize', `${intent} must end with synthesis`);
    assert.ok(plan.every((s) => s.goal.length > 5), 'every step explains itself');
  }
});

test('levers are inferred from natural language', () => {
  assert.equal(inferLevers('what if I save 8000 more a month', meera).extraMonthlySavings, 8000);
  assert.equal(inferLevers('if I cut spending by 15%', meera).expenseMultiplier, 0.85);
  assert.equal(inferLevers('can I retire 5 years early?', meera).retirementAgeDelta, -5);
  assert.equal(inferLevers('what if I work 3 more years', meera).retirementAgeDelta, 3);
  assert.equal(inferLevers('what if there is a 40% market crash', meera).marketShockPct, -0.4);
  assert.equal(inferLevers('I want to take a 6 month career break', meera).careerBreakMonths, 6);
  assert.equal(inferLevers('what if I invest a 5 lakh bonus', meera).lumpSum, 500_000);
  assert.equal(inferLevers('what if inflation runs at 9%', meera).inflationPct, 0.09);
});

test('an explicit retirement age beats a relative phrase', () => {
  const levers = inferLevers('what if I retire at 50 instead', meera);
  assert.equal(levers.retirementAgeDelta, 50 - meera.retirementAge);
});

/* -------------------------------------------------------------------------- */
/* Retrieval                                                                   */
/* -------------------------------------------------------------------------- */

test('BM25 retrieval finds the right document for domain questions', () => {
  const cases: [string, string][] = [
    ['why do I need an emergency fund', 'emergency-fund'],
    ['should I pay off my credit card or invest the money', 'debt-vs-invest'],
    ['how do I read a success probability', 'monte-carlo'],
    ['how much do I need to retire', 'safe-withdrawal'],
    ['are my fund fees too high', 'fees'],
    ['do I need term insurance', 'insurance'],
    ['what is sequencing risk near retirement', 'sequencing-risk'],
  ];
  for (const [query, expected] of cases) {
    const hits = retrieve(query, 3);
    assert.ok(hits.length > 0, `"${query}" returned nothing`);
    assert.ok(
      hits.slice(0, 2).some((h) => h.id === expected),
      `"${query}" should surface ${expected}, got ${hits.map((h) => h.id).join(', ')}`,
    );
  }
});

test('retrieval returns a usable snippet and a positive score', () => {
  const [hit] = retrieve('emergency fund', 1);
  assert.ok(hit);
  assert.ok(hit.score > 0);
  assert.ok(hit.snippet.length > 40 && hit.snippet.length <= 320);
  assert.ok(hit.content.length > hit.snippet.length);
});

test('a nonsense query returns nothing rather than a random document', () => {
  assert.equal(retrieve('zzzxyq qqqwwww', 3).length, 0);
});

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

test('every tool returns a summary and facts the verifier can use', async () => {
  const ctx = { profile: structuredClone(meera) };
  const checks: [string, unknown][] = [
    ['get_financial_snapshot', {}],
    ['analyze_portfolio', {}],
    ['recommend_allocation', {}],
    ['get_next_best_actions', { limit: 3 }],
    ['plan_debt_payoff', {}],
    ['run_monte_carlo', {}],
    ['project_goal', { goal: 'Retirement' }],
    ['simulate_scenario', { extraMonthlySavings: 10000 }],
    ['search_knowledge', { query: 'emergency fund' }],
    ['list_scenario_presets', {}],
  ];
  for (const [tool, input] of checks) {
    const result = await executeTool(tool, input, ctx);
    assert.ok(result.summary.length > 10, `${tool} produced no summary`);
    assert.ok(result.data !== undefined, `${tool} produced no data`);
    assert.ok(
      Object.values(result.facts).every((v) => Number.isFinite(v)),
      `${tool} emitted a non-finite fact`,
    );
  }
});

test('an unknown tool fails loudly but does not throw', async () => {
  const result = await executeTool('not_a_tool', {}, { profile: meera });
  assert.match(result.summary, /Unknown tool/);
});

test('project_goal reports the available goals when the name does not match', async () => {
  const result = await executeTool('project_goal', { goal: 'Yacht' }, { profile: meera });
  assert.match(result.summary, /No goal matched/);
  assert.ok((result.data as { available: string[] }).available.length > 0);
});

test('update_plan mutates the profile and reports the effect', async () => {
  let updated = null as null | typeof meera;
  const ctx = {
    profile: structuredClone(meera),
    onProfileChange: (p: typeof meera) => {
      updated = p;
    },
  };
  const result = await executeTool(
    'update_plan',
    { change: 'set_goal_contribution', goal: 'Retirement', monthlyContribution: 60000 },
    ctx,
  );
  assert.ok(updated, 'the profile change callback must fire');
  assert.equal(updated!.goals.find((g) => g.name === 'Retirement')?.monthlyContribution, 60000);
  assert.match(result.summary, /Retirement/);
});

test('update_plan refuses invalid input instead of corrupting the plan', async () => {
  const ctx = { profile: structuredClone(meera), onProfileChange: () => assert.fail('must not fire') };
  const bad = await executeTool(
    'update_plan',
    { change: 'set_goal_contribution', goal: 'Retirement', monthlyContribution: -100 },
    ctx,
  );
  assert.match(bad.summary, /Nothing changed/);

  const badAge = await executeTool('update_plan', { change: 'set_retirement_age', retirementAge: 12 }, ctx);
  assert.match(badAge.summary, /Nothing changed/);
});

/* -------------------------------------------------------------------------- */
/* Verifier                                                                    */
/* -------------------------------------------------------------------------- */

test('claim extraction reads the formats the platform actually writes', () => {
  const claims = extractClaims(
    'Your net worth is ₹1.25 Cr, you save ₹45,000 a month, retirement is 72% funded and you have 6 months of cover.',
  );
  const values = claims.map((c) => c.value);
  assert.ok(values.includes(12_500_000), 'reads Cr');
  assert.ok(values.includes(45_000), 'reads a comma-separated amount');
  assert.ok(values.includes(72), 'reads a percentage');
  assert.ok(values.includes(6), 'reads a duration');
});

test('the verifier grounds claims that match tool output and flags ones that do not', () => {
  const facts = { 'net worth': 12_500_000, 'retirement readiness': 0.72 };
  const checks = verifyAnswer('Your net worth is ₹1.25 Cr and retirement is 72% funded.', facts);
  assert.ok(checks.length >= 2);
  assert.ok(checks.every((c) => c.status === 'grounded'), JSON.stringify(checks));

  const bad = verifyAnswer('Your net worth is ₹9.99 Cr.', facts);
  assert.ok(bad.some((c) => c.status === 'unverified'));
  assert.ok(groundingRatio(bad) < 1);
});

test('the verifier tolerates prose rounding but not invention', () => {
  const facts = { corpus: 84_185_184 };
  assert.ok(
    verifyAnswer('about ₹8.42 Cr', facts).every((c) => c.status === 'grounded'),
    'rounded restatements are grounded',
  );
  assert.ok(
    verifyAnswer('about ₹12.00 Cr', facts).some((c) => c.status === 'unverified'),
    'a different figure is flagged',
  );
});

/* -------------------------------------------------------------------------- */
/* End-to-end agent                                                            */
/* -------------------------------------------------------------------------- */

async function ask(profileId: string, message: string) {
  const res = await fetch(`${baseUrl}/api/agent/${profileId}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  assert.equal(res.status, 200, `ask failed: ${res.status}`);
  return json(res);
}

async function seedProfile(personaId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/profiles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ personaId }),
  });
  return (await json(res)).profile.id;
}

test('the agent exposes its capabilities for inspection', async () => {
  const body = await json(await fetch(`${baseUrl}/api/agent/capabilities`));
  assert.ok(body.tools.length >= 10);
  assert.ok(body.knowledgeBase.length >= 10);
  assert.ok(body.tools.every((t: { description: string }) => t.description.length > 40));
});

test('the agent answers a range of questions, grounded and traced', async () => {
  const profileId = await seedProfile('meera');
  const questions = [
    'How am I doing overall?',
    'Am I on track for my retirement?',
    'What if I save 20000 more every month?',
    'What should I do next?',
    'Is my portfolio too risky?',
    'What are the chances I hit my retirement target?',
    'Why does an emergency fund matter so much?',
  ];

  for (const question of questions) {
    const { message, trace } = await ask(profileId, question);

    assert.ok(message.content.length > 120, `"${question}" produced a thin answer`);
    assert.ok(message.plan.length >= 2, `"${question}" produced no plan`);
    assert.ok(message.toolCalls.length >= 1, `"${question}" called no tools`);
    assert.ok(message.assumptions.length > 0, `"${question}" declared no assumptions`);
    assert.ok(message.citations.length > 0, `"${question}" cited nothing`);

    // The trace must contain the full workflow, not just an answer.
    const types = new Set(trace.map((e: { type: string }) => e.type));
    assert.ok(types.has('plan'), 'trace includes the plan');
    assert.ok(types.has('tool_call'), 'trace includes tool calls');
    assert.ok(types.has('tool_result'), 'trace includes tool results');
    assert.ok(types.has('final'), 'trace includes the final message');

    // In deterministic mode every figure comes from a tool, so grounding
    // should be total. A regression here means a template invented a number.
    const ratio = groundingRatio(message.verification ?? []);
    assert.ok(
      ratio >= 0.95,
      `"${question}" had grounding ${ratio.toFixed(2)}: ${JSON.stringify(
        (message.verification ?? []).filter((c: { status: string }) => c.status === 'unverified'),
      )}`,
    );
  }
});

test('the agent refuses to prioritise investing over 42% credit-card debt', async () => {
  const profileId = await seedProfile('aarav');
  const { message } = await ask(profileId, 'What should I do next?');
  const text = message.content.toLowerCase();
  assert.ok(
    text.includes('credit card') || text.includes('emergency'),
    `expected debt or buffer to lead, got: ${message.content.slice(0, 300)}`,
  );
});

test('a what-if answer reports the delta against the current plan', async () => {
  const profileId = await seedProfile('rohan');
  const { message } = await ask(profileId, 'What if there is a 35% market crash in three years?');
  assert.match(message.content, /crash|drawdown/i);
  assert.ok(message.attachments.some((a: { kind: string }) => a.kind === 'scenario'));
});

test('conversation history is persisted and replayable', async () => {
  const profileId = await seedProfile('meera');
  const first = await ask(profileId, 'How am I doing?');
  const sessionId = first.sessionId;

  const res = await fetch(`${baseUrl}/api/agent/${profileId}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'And what should I do next?', sessionId }),
  });
  const second = await json(res);
  assert.equal(second.sessionId, sessionId);

  const session = await json(await fetch(`${baseUrl}/api/agent/sessions/${sessionId}`));
  assert.equal(session.messages.length, 4, 'two user turns and two assistant turns');
  assert.equal(session.messages[0].role, 'user');
  assert.equal(session.messages[1].role, 'assistant');

  const sessions = await json(await fetch(`${baseUrl}/api/agent/${profileId}/sessions`));
  assert.ok(sessions.some((s: { id: string }) => s.id === sessionId));
});

test('the streaming endpoint emits a well-formed SSE trace', async () => {
  const profileId = await seedProfile('meera');
  const res = await fetch(
    `${baseUrl}/api/agent/${profileId}/stream?message=${encodeURIComponent('How am I doing?')}`,
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

  const body = await res.text();
  assert.match(body, /event: run_started/);
  assert.match(body, /event: plan/);
  assert.match(body, /event: tool_call/);
  assert.match(body, /event: tool_result/);
  assert.match(body, /event: final/);
  assert.match(body, /event: done/);

  // Each frame must be parseable on its own - a malformed one silently breaks
  // the client's EventSource.
  const dataLines = body.split('\n').filter((l) => l.startsWith('data: ') && l.length > 8);
  assert.ok(dataLines.length > 4);
  for (const line of dataLines) {
    JSON.parse(line.slice(6));
  }
});

test('the stream rejects an empty message', async () => {
  const profileId = await seedProfile('meera');
  const res = await fetch(`${baseUrl}/api/agent/${profileId}/stream?message=`);
  assert.equal(res.status, 400);
});

test('asking about an unknown profile is a 404', async () => {
  const res = await fetch(`${baseUrl}/api/agent/nope/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'hello' }),
  });
  assert.equal(res.status, 404);
});

test('the agent applies an explicit plan change on request', async () => {
  const profileId = await seedProfile('meera');
  const { message } = await ask(profileId, 'Increase my Retirement contribution to 45000');
  assert.ok(message.toolCalls.some((t: { tool: string }) => t.tool === 'update_plan'));

  const profile = await json(await fetch(`${baseUrl}/api/profiles/${profileId}`));
  assert.equal(profile.goals.find((g: { name: string }) => g.name === 'Retirement')?.monthlyContribution, 45000);
});
