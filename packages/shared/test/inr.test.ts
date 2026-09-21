import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ASSUMPTIONS,
  PERSONAS,
  formatCompact,
  formatDelta,
  resolveAssumptions,
} from '../src/index.js';
import type { UserProfile } from '../src/types.js';

/**
 * INR-only invariants.
 *
 * The platform had a second display currency and an illustrative FX rate; both
 * are gone. What is worth pinning is what replaced them: amounts are always
 * lakh/crore rupees, and a ledger override survives a round trip through
 * `resolveAssumptions` byte-for-byte, because nothing restates it any more.
 */

test('money is always formatted in lakh and crore', () => {
  assert.equal(formatCompact(60_000_000), '₹6.00 Cr');
  assert.equal(formatCompact(500_000), '₹5.00 L');
  assert.equal(formatCompact(12_000), '₹12.0k');
  assert.equal(formatCompact(-500_000), '-₹5.00 L');
  assert.equal(formatDelta(140_000), '+₹1.40 L');

  // The K/M/B scale went with the dollar path; a crore must never read as "60M".
  for (const value of [60_000_000, 500_000, 12_000, 1_500_000_000]) {
    const out = formatCompact(value);
    assert.ok(!/[KMB]/.test(out), `${value} formatted as ${out}`);
  }
});

test('assumptions are the house view, unrestated', () => {
  const profile = { currency: 'INR' } as UserProfile;
  assert.deepEqual(resolveAssumptions(profile), DEFAULT_ASSUMPTIONS);
});

test('a ledger override round-trips unchanged', () => {
  // With one currency there is no conversion step left to distort an override,
  // so what the user typed is exactly what the engine reads back.
  const typed = 1_250_000;
  const resolved = resolveAssumptions({
    currency: 'INR',
    assumptionOverrides: { healthCoverFloor40To55: typed, inflationPct: 0.072 },
  } as UserProfile);

  assert.equal(resolved.healthCoverFloor40To55, typed);
  assert.equal(resolved.inflationPct, 0.072);
  // Untouched keys still come from the house view.
  assert.equal(resolved.healthCoverPerDependent, DEFAULT_ASSUMPTIONS.healthCoverPerDependent);
});

test('every persona is an INR profile', () => {
  for (const persona of PERSONAS) {
    assert.equal(persona.profile.currency, 'INR', `${persona.id} should be INR`);
  }
});
