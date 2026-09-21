import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ASSUMPTIONS } from '../src/assumptions.js';
import { personaById } from '../src/data/personas.js';
import { buildSnapshot } from '../src/finance/engine.js';
import { allocateSurplus, optimiseGoalFunding } from '../src/optimiser.js';
import { sum } from '../src/finance/math.js';
import type { Goal, UserProfile } from '../src/types.js';

/**
 * The optimiser is the only part of the platform that decides *between* goals,
 * so its invariants are the ones a user would be hurt by if they broke: money
 * cannot be invented, a goal cannot be given more than it needs, and the
 * ordering has to be the one the Assumptions ledger says it is.
 */

const FIXED_NOW = new Date('2026-01-01T00:00:00.000Z');
const YEAR = FIXED_NOW.getUTCFullYear();

function persona(id: string): UserProfile {
  const p = personaById(id);
  assert.ok(p, `persona ${id} exists`);
  return structuredClone(p.profile);
}

function goal(over: Partial<Goal> & Pick<Goal, 'id' | 'name' | 'targetYear'>): Goal {
  return {
    kind: 'custom',
    targetAmountToday: 1_000_000,
    currentSaved: 0,
    monthlyContribution: 0,
    contributionStepUpPct: 0,
    priority: 'important',
    ...over,
  };
}

/** Every goal funded from the same mix, so ordering tests isolate the scoring. */
function flatReturns(goals: Goal[], rate = 0.09): Record<string, number> {
  return Object.fromEntries(goals.map((g) => [g.id, rate]));
}

function allocate(goals: Goal[], available: number, assumptions = DEFAULT_ASSUMPTIONS) {
  return allocateSurplus({
    goals,
    available,
    assumptions,
    returnsByGoal: flatReturns(goals),
    now: FIXED_NOW,
  });
}

/* -------------------------------------------------------------------------- */
/* Conservation                                                                */
/* -------------------------------------------------------------------------- */

test('the allocation never creates or loses money', () => {
  const goals = [
    goal({ id: 'a', name: 'Near', targetYear: YEAR + 2 }),
    goal({ id: 'b', name: 'Mid', targetYear: YEAR + 8 }),
    goal({ id: 'c', name: 'Far', targetYear: YEAR + 20 }),
  ];
  const pool = 30_000;
  const result = allocate(goals, pool);

  const handedOut = sum(result.allocations.map((a) => a.allocated));
  assert.ok(
    Math.abs(handedOut + result.unallocated - pool) < 1,
    `allocated ${handedOut} + unallocated ${result.unallocated} must equal the ${pool} pool`,
  );
  assert.ok(result.unallocated >= 0, 'the leftover is never negative');
  assert.equal(result.toRetirementGap + result.toInvest, result.unallocated);
});

test('no goal is given more than it needs', () => {
  const goals = [
    goal({ id: 'a', name: 'Small', targetYear: YEAR + 3, targetAmountToday: 200_000 }),
    goal({ id: 'b', name: 'Large', targetYear: YEAR + 15, targetAmountToday: 9_000_000 }),
  ];
  // Deliberately more than the two of them together could absorb.
  const result = allocate(goals, 5_000_000);
  for (const a of result.allocations) {
    assert.ok(
      a.allocated <= a.requiredMonthly + 0.5,
      `${a.goalName} got ${a.allocated} against a requirement of ${a.requiredMonthly}`,
    );
  }
  assert.ok(result.unallocated > 0, 'a pool that funds everything leaves a remainder');
  assert.ok(
    result.allocations.every((a) => a.onTrack),
    'fully funded goals are reported on track',
  );
});

/* -------------------------------------------------------------------------- */
/* Ordering                                                                    */
/* -------------------------------------------------------------------------- */

test('priority weight changes who gets funded', () => {
  const goals = [
    goal({ id: 'must', name: 'Must', targetYear: YEAR + 9, priority: 'must_have' }),
    goal({ id: 'nice', name: 'Nice', targetYear: YEAR + 4, priority: 'aspirational' }),
  ];
  // A pool too small for both, so the ordering is the whole result.
  const houseView = allocate(goals, 6_000);
  const reweighted = allocate(goals, 6_000, {
    ...DEFAULT_ASSUMPTIONS,
    // A user who says a nice-to-have matters as much as a must-have.
    goalWeightAspirational: 3,
  });

  const got = (r: ReturnType<typeof allocate>, id: string) =>
    r.allocations.find((a) => a.goalId === id)?.allocated ?? 0;

  assert.ok(
    got(houseView, 'must') > 0 && got(houseView, 'nice') === 0,
    'on the house view the must-have is funded first even though it is five years further out',
  );
  assert.ok(
    got(reweighted, 'nice') > got(houseView, 'nice'),
    'changing a weight in the ledger must move real money',
  );
  assert.equal(reweighted.allocations[0]?.goalId, 'nice', 'and it must change the order');
});

test('the near-term floor funds an imminent goal ahead of a longer one of equal priority', () => {
  /*
   * The far goal is engineered to out-score the near one on deficit alone: it is
   * entirely unfunded while the near goal is most of the way there. Without the
   * floor, score order would fund the far goal first and leave a goal due inside
   * the window short with no time left to recover.
   */
  const goals = [
    goal({
      id: 'near',
      name: 'Near',
      targetYear: YEAR + 1,
      priority: 'important',
      targetAmountToday: 500_000,
      currentSaved: 400_000,
    }),
    goal({
      id: 'far',
      name: 'Far',
      targetYear: YEAR + 3,
      priority: 'important',
      targetAmountToday: 5_000_000,
      currentSaved: 0,
    }),
  ];

  const scored = allocate(goals, 0).allocations;
  const near = scored.find((a) => a.goalId === 'near');
  const far = scored.find((a) => a.goalId === 'far');
  assert.ok(near && far);
  assert.ok(near.nearTerm && !far.nearTerm, 'the fixture is set up as intended');
  assert.ok(far.score > near.score, 'the far goal does out-score the near one');

  const result = allocate(goals, 9_000);
  const nearGot = result.allocations.find((a) => a.goalId === 'near')?.allocated ?? 0;
  assert.ok(nearGot > 0, 'the near-term goal funds first despite the lower score');
  assert.equal(result.allocations[0]?.goalId, 'near');
});

test('the near-term floor does not override priority', () => {
  const goals = [
    goal({ id: 'soon', name: 'Soon but optional', targetYear: YEAR + 1, priority: 'aspirational' }),
    goal({ id: 'must', name: 'Must have', targetYear: YEAR + 2, priority: 'must_have' }),
  ];
  const result = allocate(goals, 5_000);
  assert.equal(
    result.allocations[0]?.goalId,
    'must',
    'a near-term aspirational goal must not jump a must-have',
  );
});

/* -------------------------------------------------------------------------- */
/* Consequences                                                                */
/* -------------------------------------------------------------------------- */

test('starved goals report the delay in years, not just rupees', () => {
  const goals = [
    goal({ id: 'a', name: 'Funded', targetYear: YEAR + 2, targetAmountToday: 300_000 }),
    goal({ id: 'b', name: 'Starved', targetYear: YEAR + 6, targetAmountToday: 2_000_000 }),
  ];
  const result = allocate(goals, 12_000);

  const starved = result.starved.find((s) => s.goalId === 'b');
  assert.ok(starved, 'the underfunded goal is reported');
  assert.ok(starved.unmetMonthly > 0);
  if (starved.yearsDelayIfUnfunded !== null) {
    assert.ok(starved.yearsDelayIfUnfunded > 0, 'a delay is a positive number of years');
    assert.ok(Number.isFinite(starved.yearsDelayIfUnfunded));
  }
  assert.ok(result.rationale.length > 40, 'the tradeoff is stated in words');
});

test('a goal that can never be reached reports null rather than a made-up number', () => {
  const goals = [
    goal({
      id: 'impossible',
      name: 'Impossible',
      targetYear: YEAR + 5,
      targetAmountToday: 500_000_000,
    }),
  ];
  const result = allocate(goals, 0);
  const starved = result.starved.find((s) => s.goalId === 'impossible');
  assert.ok(starved);
  assert.equal(starved.yearsDelayIfUnfunded, null);
});

/* -------------------------------------------------------------------------- */
/* Edges                                                                       */
/* -------------------------------------------------------------------------- */

test('zero and negative pools allocate nothing and say why', () => {
  const goals = [goal({ id: 'a', name: 'A', targetYear: YEAR + 5 })];

  for (const pool of [0, -45_000]) {
    const result = allocate(goals, pool);
    assert.equal(sum(result.allocations.map((a) => a.allocated)), 0);
    assert.equal(result.unallocated, 0, 'a negative pool is not a negative leftover');
    assert.equal(result.starved.length, 1);
    assert.match(result.rationale, /nothing to allocate|commits more/i);
  }
});

test('no goals at all is not an error', () => {
  const result = allocate([], 50_000);
  assert.deepEqual(result.allocations, []);
  assert.deepEqual(result.starved, []);
  assert.equal(result.unallocated, 50_000);
});

test('one goal whose requirement exceeds the entire pool takes all of it and no more', () => {
  const goals = [
    goal({ id: 'big', name: 'Big', targetYear: YEAR + 4, targetAmountToday: 20_000_000 }),
  ];
  const result = allocate(goals, 25_000);
  const only = result.allocations[0];
  assert.ok(only);
  assert.equal(only.allocated, 25_000);
  assert.ok(only.requiredMonthly > 25_000);
  assert.equal(result.unallocated, 0);
  assert.ok(!only.onTrack);
  assert.ok(only.resultingFundedRatio < 1);
});

test('leftover money goes to the retirement gap before anything else', () => {
  const goals = [goal({ id: 'a', name: 'A', targetYear: YEAR + 3, targetAmountToday: 100_000 })];
  const result = allocateSurplus({
    goals,
    available: 50_000,
    assumptions: DEFAULT_ASSUMPTIONS,
    returnsByGoal: flatReturns(goals),
    retirementGapMonthly: 12_000,
    now: FIXED_NOW,
  });
  assert.equal(result.toRetirementGap, 12_000);
  assert.equal(result.toInvest, result.unallocated - 12_000);
  assert.ok(result.toInvest > 0);
});

/* -------------------------------------------------------------------------- */
/* Against the real personas                                                   */
/* -------------------------------------------------------------------------- */

test('the pool includes what the goals already receive, not just free surplus', () => {
  // Meera's free surplus is negative: an optimiser that only divided spare cash
  // would have nothing to say to the person who most needs it. What it can say
  // is that the money already committed is pointed at the wrong goals.
  const profile = persona('meera');
  const snapshot = buildSnapshot(profile, FIXED_NOW);
  const committed = sum(profile.goals.map((g) => g.monthlyContribution));

  assert.ok(snapshot.cashflow.monthlySurplus < 0, 'the fixture is the hard case');

  const result = optimiseGoalFunding({ profile, snapshot, now: FIXED_NOW });
  assert.ok(Math.abs(result.available - (snapshot.cashflow.monthlySurplus + committed)) < 1);
  assert.ok(result.available > 0, 'there is something to reallocate even with no surplus');
  assert.ok(result.starved.length > 0, 'and it is not enough for everything');
  assert.ok(result.rationale.includes('funded first'));
});

test('a surplus override answers the what-if without touching the plan', () => {
  const profile = persona('meera');
  const before = structuredClone(profile);
  const result = optimiseGoalFunding({ profile, surplusOverride: 500_000, now: FIXED_NOW });

  assert.equal(result.available, 500_000);
  assert.ok(
    result.allocations.every((a) => a.allocated <= a.requiredMonthly + 0.5),
    'a large pool still caps each goal at what it needs',
  );
  assert.deepEqual(profile, before, 'the optimiser does not mutate the profile');
});

test('the same plan always produces the same allocation', () => {
  const profile = persona('rohan');
  assert.deepEqual(
    optimiseGoalFunding({ profile, now: FIXED_NOW }),
    optimiseGoalFunding({ profile, now: FIXED_NOW }),
  );
});
