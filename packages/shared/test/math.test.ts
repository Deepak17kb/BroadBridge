import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  annuityFactor,
  createRng,
  emiFor,
  futureValueLumpSum,
  monthlyRate,
  monthsToPayoff,
  percentile,
  requiredMonthlyContribution,
  solveRequiredReturn,
  steppedAnnuityFactor,
} from '../src/finance/math.js';

test('monthlyRate compounds geometrically, not by division', () => {
  const r = monthlyRate(0.12);
  // (1+r)^12 must return exactly 1.12 - the r/12 shortcut would give 1.1268.
  assert.ok(Math.abs(Math.pow(1 + r, 12) - 1.12) < 1e-12);
  assert.ok(r < 0.12 / 12, 'geometric monthly rate is below the naive r/12');
});

test('annuityFactor matches the closed-form sum', () => {
  const i = 0.01;
  const n = 24;
  let expected = 0;
  for (let k = 0; k < n; k++) expected += Math.pow(1 + i, k);
  assert.ok(Math.abs(annuityFactor(i, n) - expected) < 1e-9);
});

test('annuityFactor degrades to n at a zero rate', () => {
  assert.equal(annuityFactor(0, 36), 36);
});

test('steppedAnnuityFactor with no step-up equals the plain annuity factor', () => {
  const annual = 0.1;
  const years = 15;
  const i = monthlyRate(annual);
  const plain = annuityFactor(i, years * 12);
  const stepped = steppedAnnuityFactor(annual, years, 0);
  assert.ok(
    Math.abs(plain - stepped) / plain < 1e-9,
    `expected ${plain}, got ${stepped}`,
  );
});

test('steppedAnnuityFactor grows with the step-up rate', () => {
  const flat = steppedAnnuityFactor(0.1, 20, 0);
  const stepped = steppedAnnuityFactor(0.1, 20, 0.1);
  assert.ok(stepped > flat * 1.5, 'a 10% annual step-up over 20 years should dominate a flat SIP');
});

test('steppedAnnuityFactor honours a contribution pause', () => {
  const full = steppedAnnuityFactor(0.1, 10, 0);
  const paused = steppedAnnuityFactor(0.1, 10, 0, 12);
  assert.ok(paused < full);
  // 12 of 120 contributions skipped, and they were the earliest (most valuable),
  // so the loss should exceed a flat 10%.
  assert.ok((full - paused) / full > 0.1);
});

test('requiredMonthlyContribution round-trips through the projection', () => {
  const target = 10_000_000;
  const corpus = 500_000;
  const years = 18;
  const rate = 0.11;
  const stepUp = 0.07;
  const contribution = requiredMonthlyContribution(target, corpus, rate, years, stepUp);
  const achieved =
    futureValueLumpSum(corpus, rate, years) +
    contribution * steppedAnnuityFactor(rate, years, stepUp);
  assert.ok(
    Math.abs(achieved - target) / target < 1e-9,
    `solved contribution lands on the target (got ${achieved})`,
  );
});

test('requiredMonthlyContribution is zero when the corpus already gets there', () => {
  assert.equal(requiredMonthlyContribution(1_000_000, 900_000, 0.1, 10, 0), 0);
});

test('solveRequiredReturn round-trips', () => {
  const target = 8_000_000;
  const r = solveRequiredReturn(target, 300_000, 15_000, 15, 0);
  assert.ok(r !== null);
  const achieved =
    futureValueLumpSum(300_000, r as number, 15) +
    15_000 * steppedAnnuityFactor(r as number, 15, 0);
  assert.ok(Math.abs(achieved - target) / target < 1e-6);
});

test('solveRequiredReturn refuses impossible targets instead of guessing', () => {
  // 1000/month for 5 years can never become 100 crore.
  assert.equal(solveRequiredReturn(1_000_000_000, 0, 1000, 5, 0), null);
});

test('seeded RNG is reproducible and stays in range', () => {
  const a = createRng(42);
  const b = createRng(42);
  const c = createRng(43);
  const seqA = Array.from({ length: 50 }, () => a());
  const seqB = Array.from({ length: 50 }, () => b());
  const seqC = Array.from({ length: 50 }, () => c());
  assert.deepEqual(seqA, seqB, 'same seed must produce the same sequence');
  assert.notDeepEqual(seqA, seqC, 'different seeds must diverge');
  assert.ok(seqA.every((v) => v >= 0 && v < 1));
});

test('percentile interpolates and handles the edges', () => {
  const values = [10, 20, 30, 40, 50];
  assert.equal(percentile(values, 0), 10);
  assert.equal(percentile(values, 1), 50);
  assert.equal(percentile(values, 0.5), 30);
  assert.equal(percentile(values, 0.25), 20);
  assert.equal(percentile([], 0.5), 0);
});

test('percentile does not mutate its input', () => {
  const values = [5, 1, 3];
  percentile(values, 0.5);
  assert.deepEqual(values, [5, 1, 3]);
});

test('monthsToPayoff and emiFor are mutually consistent', () => {
  const principal = 500_000;
  const rate = 0.1;
  const months = 60;
  const emi = emiFor(principal, rate, months);
  const solved = monthsToPayoff(principal, rate, emi);
  assert.ok(Math.abs(solved - months) <= 1, `expected ~${months} months, got ${solved}`);
});

test('monthsToPayoff reports Infinity when the payment cannot cover interest', () => {
  // 100 a month against 42% APR on 150k is never getting paid off.
  assert.equal(monthsToPayoff(150_000, 0.42, 100), Infinity);
});
