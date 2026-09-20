import type { VerificationCheck } from '@wealth/shared';

/**
 * Grounding verifier.
 *
 * After the model writes its answer, every financial figure in the prose is
 * extracted and matched against the numbers the tools actually returned. A
 * figure with no matching tool output is reported as unverified rather than
 * silently trusted.
 *
 * This is the safety net behind "the model never does arithmetic". The system
 * prompt asks it not to; this checks. It runs on the deterministic path too,
 * where it should always come back fully grounded - which makes it a useful
 * regression test on the templates as well.
 */

const SCALES: Record<string, number> = {
  cr: 1e7,
  crore: 1e7,
  crores: 1e7,
  l: 1e5,
  lakh: 1e5,
  lakhs: 1e5,
  lac: 1e5,
  k: 1e3,
  m: 1e6,
  b: 1e9,
};

interface Claim {
  /** The literal text as written, for display. */
  text: string;
  value: number;
  kind: 'currency' | 'percent' | 'duration';
}

/**
 * Pulls candidate numeric claims out of the answer.
 *
 * Deliberately conservative: bare small integers and four-digit years are
 * skipped, because flagging "3 goals" or "by 2045" as unverified would bury the
 * signal that matters under noise.
 */
export function extractClaims(text: string): Claim[] {
  const claims: Claim[] = [];
  const seen = new Set<string>();

  const push = (raw: string, value: number, kind: Claim['kind']) => {
    if (!Number.isFinite(value)) return;
    const key = `${kind}:${value.toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    claims.push({ text: raw.trim(), value, kind });
  };

  // Percentages: "12.5%", "70 %"
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
    push(match[0], Number.parseFloat(match[1] ?? ''), 'percent');
  }

  // Currency with an optional symbol and scale suffix: "₹1.25 Cr", "$45,000", "2 lakh"
  for (const match of text.matchAll(
    /(?:[₹$]\s*)?(\d[\d,]*(?:\.\d+)?)\s*(cr|crores?|lakhs?|lac|l|k|m|b)\b/gi,
  )) {
    const base = Number.parseFloat((match[1] ?? '').replace(/,/g, ''));
    const scale = SCALES[(match[2] ?? '').toLowerCase()] ?? 1;
    push(match[0], base * scale, 'currency');
  }

  /*
   * Plain currency amounts with a symbol or thousands separators.
   *
   * The lookahead must list every scale suffix the formatter can emit,
   * including the bare `L` for lakh. Omitting one makes "₹53.58 L" match twice -
   * correctly as 5,358,000 above, and again as a bogus ₹53.58 here, which then
   * gets reported as an unverified claim the narration never made.
   */
  for (const match of text.matchAll(
    /[₹$]\s*(\d[\d,]*(?:\.\d+)?)(?![\d.,]*\s*(?:cr|crore|lakh|lac|l|k|m|b)\b)/gi,
  )) {
    push(match[0], Number.parseFloat((match[1] ?? '').replace(/,/g, '')), 'currency');
  }

  // Durations: "6 months", "14 years"
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(months?|years?)\b/gi)) {
    push(match[0], Number.parseFloat(match[1] ?? ''), 'duration');
  }

  return claims;
}

/**
 * Relative tolerance, loosened for small values where rounding dominates.
 *
 * Compares magnitudes, because sign is a presentation choice: a surplus fact of
 * -31000 is written "over-committed by ₹31.0k", and the figure is grounded even
 * though the minus sign lives in the sentence rather than the number.
 */
function matches(claim: number, fact: number): boolean {
  const a = Math.abs(claim);
  const b = Math.abs(fact);
  if (a === b) return true;
  const scale = Math.max(a, b);
  if (scale === 0) return true;
  // Prose rounds: "1.25 Cr" stands for anything from 1.245 to 1.255 Cr.
  const tolerance = scale < 10 ? 0.06 : scale < 1000 ? 0.03 : 0.015;
  return Math.abs(a - b) / scale <= tolerance;
}

/**
 * Cross-checks the answer against the tool outputs.
 *
 * `facts` is the union of every number the tools returned this turn, keyed by
 * label so a matched claim can name its source.
 */
export function verifyAnswer(
  answer: string,
  facts: Record<string, number>,
  limit = 10,
): VerificationCheck[] {
  const claims = extractClaims(answer);
  if (claims.length === 0) return [];

  const entries = Object.entries(facts);
  const checks: VerificationCheck[] = [];

  for (const claim of claims.slice(0, limit)) {
    let evidence: string | null = null;

    for (const [label, value] of entries) {
      /*
       * Only percentages get a scaled reading: a ratio fact of 0.72 is written
       * "72%", and some percentage facts (drift, scores) are already scaled.
       *
       * Currency and duration claims are matched against the raw value only.
       * Allowing a x100 or /100 reading there produced confident-looking false
       * matches - "₹1.47 L" would happily bind to an unrelated ₹1.56 Cr fact -
       * which is worse than reporting the claim as unverified, because it
       * attaches the wrong evidence to a correct number.
       */
      const candidates = claim.kind === 'percent' ? [value * 100, value] : [value];
      if (candidates.some((candidate) => matches(claim.value, candidate))) {
        evidence = label;
        break;
      }
    }

    checks.push({
      claim: claim.text,
      status: evidence ? 'grounded' : 'unverified',
      evidence: evidence
        ? `Matches "${evidence}" from tool output`
        : 'No tool output produced this figure',
    });
  }

  return checks;
}

/** Share of checked claims that traced back to a tool output. */
export function groundingRatio(checks: VerificationCheck[]): number {
  if (checks.length === 0) return 1;
  return checks.filter((c) => c.status === 'grounded').length / checks.length;
}
