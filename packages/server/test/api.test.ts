import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';

/**
 * API integration tests against a real listening server.
 *
 * Using fetch over a live port rather than a request-mocking library keeps the
 * tests honest about serialisation, status codes and the SSE framing - the
 * things that actually break between the client and the API.
 */

let server: Server;
let baseUrl: string;

before(async () => {
  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
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

/** `Response.json()` is typed `unknown`; these tests assert on shapes they own. */
async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function createProfile(personaId = 'meera'): Promise<{ id: string }> {
  const res = await api('/api/profiles', {
    method: 'POST',
    body: JSON.stringify({ personaId }),
  });
  assert.equal(res.status, 201);
  const body = await json(res);
  return body.profile;
}

test('health and readiness report the active engine and store', async () => {
  const health = await json(await api('/api/health'));
  assert.equal(health.status, 'ok');
  assert.ok(['bedrock', 'anthropic', 'deterministic'].includes(health.engine));

  const ready = await json(await api('/api/ready'));
  assert.equal(ready.status, 'ready');
  assert.ok(['memory', 'dynamodb'].includes(ready.store));
});

test('the assumptions ledger is publicly inspectable', async () => {
  const res = await api('/api/meta/assumptions');
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.ok(body.assumptions.inflationPct > 0);
  assert.ok(body.assumptions.expectedReturns.equity_domestic > 0);
  assert.ok(body.riskQuestions.length >= 6);
  assert.match(body.disclaimer, /not financial advice/i);
});

test('personas are listed with the planning problem each one illustrates', async () => {
  const personas = await json(await api('/api/profiles/personas'));
  assert.equal(personas.length, 3);
  for (const p of personas) {
    assert.ok(p.id && p.label && p.challenge);
    assert.ok(p.summary.goals > 0);
  }
});

test('creating a profile from a persona returns a full snapshot', async () => {
  const res = await api('/api/profiles', {
    method: 'POST',
    body: JSON.stringify({ personaId: 'aarav', displayName: 'Test User' }),
  });
  assert.equal(res.status, 201);
  const { profile, snapshot } = await json(res);

  assert.equal(profile.displayName, 'Test User');
  // The persona's own id must not leak - two sessions would collide.
  assert.notEqual(profile.id, 'persona-aarav');
  assert.equal(profile.isSynthetic, true);
  assert.ok(snapshot.wellness.total >= 0);
  assert.ok(snapshot.actions.length > 0);
  assert.equal(snapshot.goalProjections.length, profile.goals.length);
});

test('an unknown persona is a 404, not a silently empty profile', async () => {
  const res = await api('/api/profiles', {
    method: 'POST',
    body: JSON.stringify({ personaId: 'does-not-exist' }),
  });
  assert.equal(res.status, 404);
});

test('a blank profile is created when no persona is given', async () => {
  const res = await api('/api/profiles', {
    method: 'POST',
    body: JSON.stringify({ displayName: 'From Scratch' }),
  });
  assert.equal(res.status, 201);
  const { profile } = await json(res);
  assert.equal(profile.goals.length, 0);
  assert.equal(profile.holdings.length, 0);
});

test('patching a profile recomputes the snapshot', async () => {
  const profile = await createProfile('meera');
  const before = await json(await api(`/api/profiles/${profile.id}/snapshot`));

  const res = await api(`/api/profiles/${profile.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ liquidSavings: 5_000_000 }),
  });
  assert.equal(res.status, 200);
  const { snapshot } = await json(res);

  assert.ok(snapshot.cashflow.emergencyFundMonths > before.cashflow.emergencyFundMonths);
  assert.ok(snapshot.netWorth.netWorth > before.netWorth.netWorth);
  // A large idle cash pile should now be flagged.
  assert.ok(snapshot.actions.some((a: { id: string }) => a.id === 'deploy-idle-cash'));
});

test('invalid profile edits are rejected with field detail', async () => {
  const profile = await createProfile('meera');
  const res = await api(`/api/profiles/${profile.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ age: -5 }),
  });
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.ok(Array.isArray(body.details));
  assert.ok(body.details.some((d: { path: string }) => d.path === 'age'));
});

test('a retirement age below current age is rejected', async () => {
  const profile = await createProfile('rohan');
  const res = await api(`/api/profiles/${profile.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ retirementAge: 30 }),
  });
  assert.equal(res.status, 400);
});

test('the risk questionnaire scores without persisting unless asked', async () => {
  const profile = await createProfile('meera');
  const res = await api(`/api/profiles/${profile.id}/risk`, {
    method: 'POST',
    body: JSON.stringify({
      answers: { drawdown: 0, experience: 0, tradeoff: 0, horizon: 0, buffer: 0, flexibility: 0 },
    }),
  });
  assert.equal(res.status, 200);
  const risk = await json(res);
  assert.equal(risk.bucket, 'Conservative');
  assert.ok(risk.drivers.length > 0);

  // Not persisted, so the stored profile still scores as it did.
  const stored = await json(await api(`/api/profiles/${profile.id}/snapshot`));
  assert.notEqual(stored.risk.bucket, 'Conservative');
});

test('scenarios return an outcome and a delta against the baseline', async () => {
  const profile = await createProfile('meera');
  const res = await api(`/api/plan/${profile.id}/scenario`, {
    method: 'POST',
    body: JSON.stringify({ levers: { extraMonthlySavings: 20000 }, paths: 500 }),
  });
  assert.equal(res.status, 200);
  const result = await json(res);
  assert.ok(result.deltaVsBaseline.netWorthAtRetirement > 0);
  assert.ok(result.monteCarlo.bands.length > 0);
  assert.ok(result.explanation.length > 50);
  assert.ok(result.assumptions.length > 0);
});

test('out-of-range scenario levers are rejected', async () => {
  const profile = await createProfile('meera');
  const res = await api(`/api/plan/${profile.id}/scenario`, {
    method: 'POST',
    body: JSON.stringify({ levers: { marketShockPct: -5 } }),
  });
  assert.equal(res.status, 400);
});

test('comparing scenarios shares one baseline and ranks the results', async () => {
  const profile = await createProfile('rohan');
  const res = await api(`/api/plan/${profile.id}/scenarios/compare`, {
    method: 'POST',
    body: JSON.stringify({
      scenarios: [
        { label: 'Save more', levers: { extraMonthlySavings: 25000 } },
        { label: 'Work longer', levers: { retirementAgeDelta: 3 } },
        { label: 'Crash', levers: { marketShockPct: -0.3, shockYear: 2 } },
      ],
      paths: 400,
    }),
  });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.results.length, 3);
  assert.ok(body.baseline.netWorthAtRetirement > 0);
  const crash = body.results.find((r: { label: string }) => r.label === 'Crash');
  assert.ok(crash.deltaVsBaseline.netWorthAtRetirement < 0, 'the crash scenario must be worse');
});

test('goal projection accepts test contributions', async () => {
  const profile = await createProfile('meera');
  const full = await json(await api(`/api/profiles/${profile.id}`));
  const goal = full.goals[0];

  const base = await json(
    await api(`/api/plan/${profile.id}/goals/${goal.id}/project`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  );
  const boosted = await json(
    await api(`/api/plan/${profile.id}/goals/${goal.id}/project`, {
      method: 'POST',
      body: JSON.stringify({ extraMonthly: 30000 }),
    }),
  );

  assert.ok(boosted.projectedCorpus > base.projectedCorpus);
  assert.ok(base.assumptions.length >= 4);
});

test('the allocation ladder is ordered by risk', async () => {
  const profile = await createProfile('meera');
  const ladder = await json(await api(`/api/plan/${profile.id}/allocation`));
  assert.equal(ladder.length, 5);
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(
      ladder[i].expectedReturnPct > ladder[i - 1].expectedReturnPct,
      `${ladder[i].bucket} should out-yield ${ladder[i - 1].bucket}`,
    );
  }
});

test('the debt plan prefers avalanche and quantifies the saving', async () => {
  const profile = await createProfile('aarav');
  const res = await api(`/api/plan/${profile.id}/debt-plan`, {
    method: 'POST',
    body: JSON.stringify({ extraMonthly: 10000 }),
  });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.ok(body.avalanche.totalInterestPaid <= body.snowball.totalInterestPaid);
  assert.ok(body.avalanche.monthsToDebtFree > 0);
  // Highest rate first: the 42% card must lead.
  assert.match(body.avalanche.order[0].name, /Credit Card/);
});

test('deleting a profile makes it unreachable', async () => {
  const profile = await createProfile('aarav');
  assert.equal((await api(`/api/profiles/${profile.id}`)).status, 200);
  assert.equal((await api(`/api/profiles/${profile.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await api(`/api/profiles/${profile.id}`)).status, 404);
});

test('unknown routes return a helpful 404 payload', async () => {
  const res = await api('/api/nope');
  assert.equal(res.status, 404);
  const body = await json(res);
  assert.match(body.error, /No route/);
});
