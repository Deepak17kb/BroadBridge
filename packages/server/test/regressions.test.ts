import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PERSONAS, type AgentEvent, type ChatSession, type UserProfile } from '@wealth/shared';
import { createApp } from '../src/app.js';
import { extractNumbers, inferLevers } from '../src/agent/intent.js';
import { runAgent } from '../src/agent/orchestrator.js';
import { executeTool, TOOL_MAP } from '../src/agent/tools.js';
import { profileSchema } from '../src/routes/profiles.js';
import { DynamoStore } from '../src/store/index.js';

/**
 * Regression tests for bugs found in a full-platform bug sweep: request
 * validation holes that stored unusable profiles, the agent's unvalidated tool
 * inputs, conversation ownership, the deterministic parser and synthesiser,
 * and the DynamoDB session lookup. All of it runs with no credentials.
 */

let server: Server;
let baseUrl: string;

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

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function createProfile(personaId?: string): Promise<UserProfile> {
  const res = await api('/api/profiles', {
    method: 'POST',
    body: JSON.stringify(personaId ? { personaId } : { displayName: 'Blank' }),
  });
  assert.equal(res.status, 201);
  return (await json(res)).profile;
}

const persona = (id: string): UserProfile =>
  structuredClone(PERSONAS.find((p) => p.id === id)!.profile);

/* -------------------------------------------------------------------------- */
/* Profile validation                                                          */
/* -------------------------------------------------------------------------- */

test('a PATCH with an incomplete goal is rejected and the profile survives it', async () => {
  const { id } = await createProfile('meera');
  const res = await api(`/api/profiles/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ goals: [{ id: 'x' }] }),
  });
  assert.equal(res.status, 400, 'a goal with no name, target or year is not a goal');
  const snapshot = await api(`/api/profiles/${id}/snapshot`);
  assert.equal(snapshot.status, 200, 'the stored profile is untouched and still projects');
});

test('assumption overrides are validated, not stored as anything at all', async () => {
  const { id } = await createProfile('meera');
  for (const bad of [
    { inflationPct: 'abc' },
    { expectedReturns: { equity_domestic: 'x' } },
    { expectedReturns: { stocks: 0.1 } },
    { safeWithdrawalRatePct: 0 },
  ]) {
    const res = await api(`/api/profiles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ assumptionOverrides: bad }),
    });
    assert.equal(res.status, 400, `${JSON.stringify(bad)} is rejected`);
  }
  const snapshot = await json(await api(`/api/profiles/${id}/snapshot`));
  assert.ok(Number.isFinite(snapshot.retirement.corpusRequired), 'projections are still numbers');

  const ok = await api(`/api/profiles/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ assumptionOverrides: { inflationPct: 0.07, expectedReturns: { gold: 0.09 } } }),
  });
  assert.equal(ok.status, 200);
  const body = await json(ok);
  assert.equal(body.snapshot.assumptions.inflationPct, 0.07);
  assert.equal(body.snapshot.assumptions.expectedReturns.gold, 0.09);
});

/* -------------------------------------------------------------------------- */
/* Scenario levers                                                             */
/* -------------------------------------------------------------------------- */

test('an allocation lever must name real asset classes with some weight', async () => {
  const { id } = await createProfile('meera');
  for (const allocation of [{ stocks: 1 }, { equity_domestic: 0 }]) {
    const res = await api(`/api/plan/${id}/scenario`, {
      method: 'POST',
      body: JSON.stringify({ levers: { allocation } }),
    });
    assert.equal(res.status, 400, `${JSON.stringify(allocation)} would price the plan at a 0% return`);
  }
  const res = await api(`/api/plan/${id}/scenario`, {
    method: 'POST',
    body: JSON.stringify({ levers: { allocation: { equity_domestic: 0.6, debt: 0.4 } }, paths: 300 }),
  });
  assert.equal(res.status, 200);
  assert.ok((await json(res)).snapshot.expectedReturnPct > 0.08);
});

test('the agent cannot run a scenario the API would reject', async () => {
  const profile = persona('rohan');
  const bad = await executeTool('simulate_scenario', { marketShockPct: -35 }, { profile });
  assert.equal((bad.data as { error?: string }).error, 'invalid_levers');
  assert.match(bad.summary, /-0\.35/, 'the model is told the unit it should have used');
  assert.deepEqual(bad.facts, {});

  const good = await executeTool('simulate_scenario', { marketShockPct: -0.35, shockYear: 2 }, { profile });
  assert.ok(Number.isFinite((good.data as { snapshot: { netWorthAtRetirement: number } }).snapshot.netWorthAtRetirement));
  assert.ok((good.data as { snapshot: { netWorthAtRetirement: number } }).snapshot.netWorthAtRetirement > 0);

  const compared = await executeTool(
    'compare_scenarios',
    {
      scenarios: [
        { label: 'Broken', expenseMultiplier: 50 },
        { label: 'Save more', extraMonthlySavings: 5000 },
      ],
    },
    { profile },
  );
  const results = (compared.data as { results: { label: string }[] }).results;
  assert.deepEqual(results.map((r) => r.label), ['Save more']);
  assert.match(compared.summary, /Not run.*Broken/s);
});

/* -------------------------------------------------------------------------- */
/* update_plan                                                                 */
/* -------------------------------------------------------------------------- */

test('update_plan only makes changes the profile schema would accept on save', async () => {
  const profile = persona('meera');
  let saved: UserProfile | null = null;
  const ctx = { profile, onProfileChange: (p: UserProfile) => void (saved = p) };

  const fractional = await executeTool('update_plan', { change: 'set_retirement_age', retirementAge: 62.5 }, ctx);
  assert.equal((fractional.data as { error?: string }).error, 'invalid_age');

  const pastYear = await executeTool(
    'update_plan',
    { change: 'add_goal', newGoal: { name: 'Old trip', targetAmountToday: 100000, targetYear: 2020 } },
    ctx,
  );
  assert.equal((pastYear.data as { error?: string }).error, 'invalid_goal');

  const negative = await executeTool(
    'update_plan',
    { change: 'add_goal', newGoal: { name: 'Car', targetAmountToday: 500000, targetYear: 2030, monthlyContribution: -100 } },
    ctx,
  );
  assert.equal((negative.data as { error?: string }).error, 'invalid_goal');
  assert.equal(saved, null, 'nothing was changed by a rejected request');

  const added = await executeTool(
    'update_plan',
    { change: 'add_goal', newGoal: { name: 'Car', targetAmountToday: 500000, targetYear: 2030, kind: 'car' } },
    ctx,
  );
  assert.ok(saved, 'a valid goal is added');
  const stored = saved as UserProfile;
  assert.equal(stored.goals[stored.goals.length - 1]?.kind, 'custom', 'an unknown kind falls back to custom');
  assert.ok(profileSchema.safeParse(stored).success, 'and the result is a profile the API would save');
  assert.ok('new goal required monthly' in added.facts, 'its projection is found by id');
});

/* -------------------------------------------------------------------------- */
/* Conversations                                                               */
/* -------------------------------------------------------------------------- */

test("one profile cannot continue another profile's conversation", async () => {
  const a = await createProfile('aarav');
  const b = await createProfile('meera');
  const first = await json(
    await api(`/api/agent/${a.id}/ask`, { method: 'POST', body: JSON.stringify({ message: 'How am I doing?' }) }),
  );
  const second = await json(
    await api(`/api/agent/${b.id}/ask`, {
      method: 'POST',
      body: JSON.stringify({ message: 'How am I doing?', sessionId: first.sessionId }),
    }),
  );
  assert.notEqual(second.sessionId, first.sessionId, 'a fresh conversation, not a hijacked one');

  const original: ChatSession = await json(await api(`/api/agent/sessions/${first.sessionId}`));
  assert.equal(original.profileId, a.id);
  assert.equal(original.messages.length, 2, "the first profile's transcript is untouched");
  const listed = await json(await api(`/api/agent/${b.id}/sessions`));
  assert.ok(listed.some((s: { id: string }) => s.id === second.sessionId), 'the turn is in its own history');
});

/* -------------------------------------------------------------------------- */
/* Deterministic agent                                                         */
/* -------------------------------------------------------------------------- */

test('the deterministic parser reads units, word forms and durations correctly', () => {
  assert.deepEqual(extractNumbers('I have 2 kids'), [2]);
  assert.deepEqual(extractNumbers('pay off my 2 credit cards'), [2]);
  assert.deepEqual(extractNumbers('a 2008 crash'), [2008]);
  assert.deepEqual(extractNumbers('5k a month, 2 lakhs, 1.5 cr, 3 lacs'), [5000, 200000, 15000000, 300000]);

  const profile = persona('aarav');
  assert.deepEqual(inferLevers('What if the market crashes?', profile), { marketShockPct: -0.35, shockYear: 3 });
  assert.deepEqual(inferLevers('What if the market crashed 40% next year?', profile), {
    marketShockPct: -0.4,
    shockYear: 1,
  });
  assert.deepEqual(inferLevers('what if I take a 2 year career break', profile), { careerBreakMonths: 24 });
  assert.deepEqual(inferLevers('what if I invest 2 lakh', profile), { lumpSum: 200000 });
  assert.deepEqual(inferLevers('What if I save more for my 2 kids', profile), {});
  assert.equal(
    inferLevers('what if a 2008 crash hit right after I invest my bonus of 3 lakh', profile).lumpSum,
    300000,
  );
});

async function ask(profile: UserProfile, message: string): Promise<{ content: string; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  const answer = await runAgent({ profile, message, emit: (e) => events.push(e) });
  return { content: answer.content, events };
}

test('a debt question from a debt-free profile gets an answer, not a failure', async () => {
  const profile = persona('meera');
  profile.liabilities = [];
  const { content, events } = await ask(profile, 'Should I pay off my loan faster?');
  assert.ok(!events.some((e) => e.type === 'error'), 'no tool or template error');
  assert.match(content, /no liabilities/i);
});

test('a goal question with no goals never prints undefined or NaN', async () => {
  const profile = persona('meera');
  profile.goals = [];
  const { content } = await ask(profile, 'Am I on track for retirement?');
  assert.doesNotMatch(content, /NaN|undefined/);
});

test('a goal answer labels the retirement simulation as retirement, not as the goal', async () => {
  const profile = persona('meera');
  const { content } = await ask(profile, 'Am I on track for my home goal?');
  assert.match(content, /Home/);
  assert.match(content, /retirement plan as a whole/);
});

test('every tool shows its own label in the trace', async () => {
  const { events } = await ask(persona('meera'), 'Am I on track for my home goal?');
  const calls = events.filter((e): e is Extract<AgentEvent, { type: 'tool_call' }> => e.type === 'tool_call');
  assert.ok(calls.some((c) => c.tool === 'optimise_goal_funding'));
  for (const call of calls) {
    assert.equal(call.label, TOOL_MAP.get(call.tool)?.label, `${call.tool} label`);
  }
});

test('the debt comparison does not claim a saving that is not there', async () => {
  const profile = persona('meera');
  profile.liabilities = profile.liabilities.slice(0, 1);
  const result = await executeTool('plan_debt_payoff', {}, { profile });
  assert.match(result.summary, /Both orders cost the same/, 'one debt, one order');
  assert.doesNotMatch(result.summary, /Avalanche saves/);
});

/* -------------------------------------------------------------------------- */
/* DynamoDB session lookup                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A stand-in for the DynamoDB document client that honours the one rule the
 * bug depended on: `Limit` bounds the items *evaluated*, before the filter.
 */
function fakeDynamo(sessions: ChatSession[], pageSize = 2) {
  const items = sessions
    .map((s) => ({ type: 'session', sessionId: s.id, updatedAt: s.updatedAt, data: s }))
    .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
  return {
    async send(command: { input: Record<string, any> }) {
      const input = command.input;
      const start = input.ExclusiveStartKey ? Number(input.ExclusiveStartKey.index) : 0;
      const evaluate = Math.min(input.Limit ?? pageSize, pageSize);
      const slice = items.slice(start, start + evaluate);
      const id = input.ExpressionAttributeValues[':id'];
      const next = start + evaluate;
      return {
        Items: slice.filter((item) => item.sessionId === id),
        LastEvaluatedKey: next < items.length ? { index: next } : undefined,
      };
    },
  };
}

test('the DynamoDB store finds a session that is not the first one in the index', async () => {
  const sessions: ChatSession[] = Array.from({ length: 5 }, (_, i) => ({
    id: `s${i}`,
    profileId: 'p',
    messages: [],
    createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
    updatedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
  }));
  const Ctor = DynamoStore as unknown as new (client: unknown, table: string) => DynamoStore;
  const store = new Ctor(fakeDynamo(sessions), 'table');
  assert.equal((await store.getSession('s4'))?.id, 's4', 'the newest');
  assert.equal((await store.getSession('s0'))?.id, 's0', 'the oldest, three pages in');
  assert.equal(await store.getSession('missing'), null);
});
