import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERSONAS, buildSnapshot } from '../src/index.js';
import type { NextBestAction, UserProfile } from '../src/types.js';

/**
 * The merged action rules.
 *
 * Five rules became two. `align-allocation`, `reduce-concentration` and
 * `rebalance-portfolio` all said "your portfolio is not the shape you agreed
 * to", which is one decision and one trip to the broker; `deploy-idle-cash` and
 * `automate-surplus` both said "this money has no job".
 *
 * Merging is only safe if no *signal* was lost with the rule that carried it,
 * so these tests assert on the evidence and priority of the surviving action
 * rather than on the fact that it exists.
 */

function persona(id: string): UserProfile {
  const found = PERSONAS.find((p) => p.id === id);
  assert.ok(found, `persona ${id} should exist`);
  return structuredClone(found.profile);
}

function actionsFor(profile: UserProfile): NextBestAction[] {
  return buildSnapshot(profile).actions;
}

/** Evidence is optional on the shape, but every rule here must supply it. */
function evidenceOf(action: NextBestAction): Record<string, number> {
  assert.ok(action.evidence, `${action.id} offers no evidence`);
  return action.evidence;
}

function find(actions: NextBestAction[], id: string): NextBestAction | undefined {
  return actions.find((a) => a.id === id);
}

test('the retired rule ids are gone from every persona', () => {
  const retired = [
    'align-allocation',
    'reduce-concentration',
    'deploy-idle-cash',
    'automate-surplus',
  ];
  for (const p of PERSONAS) {
    const ids = actionsFor(p.profile).map((a) => a.id);
    for (const gone of retired) {
      assert.ok(!ids.includes(gone), `${p.id} still surfaces ${gone}`);
    }
  }
});

test('concentration still reaches the user, through the merged rule', () => {
  // Rohan holds one oversized single stock. That used to be its own action; it
  // must still be stated, with its own numbers, inside the merged one.
  const actions = actionsFor(persona('rohan'));
  const rebalance = find(actions, 'rebalance-portfolio');

  assert.ok(rebalance, 'rohan should be told to reshape the portfolio');
  assert.ok(
    'largest single security weight' in evidenceOf(rebalance),
    'the concentration signal must survive the merge as evidence',
  );
  assert.match(rebalance.why, /company-specific risk/);
  assert.ok(rebalance.steps.some((s) => /down to 10%/.test(s)), 'the trim step must survive');
});

test('a merged action ranks as urgently as the most urgent signal in it', () => {
  // The merge must not bury something that used to surface on its own, so the
  // score is the max of the contributing rules, never an average.
  for (const p of PERSONAS) {
    const rebalance = find(actionsFor(p.profile), 'rebalance-portfolio');
    if (!rebalance) continue;

    const weight = evidenceOf(rebalance)['largest single security weight'];
    if (typeof weight === 'number' && weight > 0.15) {
      // 48 + (weight - 0.15) * 160 is the old concentration score.
      const concentrationScore = Math.min(88, 48 + (weight - 0.15) * 160);
      assert.ok(
        rebalance.priorityScore >= concentrationScore - 0.001,
        `${p.id}: merged score ${rebalance.priorityScore} is below the concentration signal's ${concentrationScore}`,
      );
    }
  }
});

test('idle cash and an uncommitted surplus arrive as one action', () => {
  const profile = persona('meera');
  // Enough cash to be well past the emergency target, so the lump signal fires.
  profile.liquidSavings = 5_000_000;

  const deploy = find(actionsFor(profile), 'deploy-surplus');
  assert.ok(deploy, 'a large idle cash pile should be flagged');
  assert.ok('idle cash' in evidenceOf(deploy), 'the lump signal must be evidenced');
  assert.ok(deploy.impact.value > 0, 'deploying idle cash should be worth something');
  assert.equal(deploy.impact.unit, 'currency');

  // Both halves are projected over one horizon, so the headline figure is a
  // sum of comparable numbers rather than two different periods added together.
  const horizon = evidenceOf(deploy)['horizon years'];
  assert.equal(typeof horizon, 'number');
  assert.match(deploy.impact.metric, new RegExp(`${horizon} years`));
});

test('every action still explains itself', () => {
  // The merge rewrote why/steps/assumptions/evidence for two rules; this is the
  // repo-wide invariant that must hold for the rewritten ones too.
  for (const p of PERSONAS) {
    for (const action of actionsFor(p.profile)) {
      assert.ok(action.why.length > 20, `${p.id}/${action.id} has no reasoning`);
      assert.ok(action.steps.length > 0, `${p.id}/${action.id} has no steps`);
      assert.ok(action.assumptions.length > 0, `${p.id}/${action.id} states no assumptions`);
      assert.ok(Object.keys(evidenceOf(action)).length > 0);
      assert.ok(
        Number.isFinite(action.priorityScore),
        `${p.id}/${action.id} has a non-finite score`,
      );
    }
  }
});
