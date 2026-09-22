import { formatCompact, type Currency } from '@wealth/shared';
import { Card } from './ui';

/**
 * What the levers are actually worth, in this profile's own numbers.
 *
 * The column beside the sliders ended after the pin button, and a panel of
 * generic "did you know" trivia would have been worse than the empty space.
 * These are computed from the user's horizon, return and surplus, so each one
 * is a fact about *their* plan rather than about money in general - and each
 * states the arithmetic that produced it, like every other figure here.
 *
 * Closed-form compounding only: no simulation. These run on every render of a
 * page whose sliders already drive a Monte Carlo, and a second stochastic
 * model competing for the same frame is how a lab stops feeling live.
 */

/** Future value of `monthly` paid for `years` at `annualRate`, compounded monthly. */
function futureValueOfMonthly(monthly: number, years: number, annualRate: number): number {
  const r = annualRate / 12;
  const n = Math.round(years * 12);
  if (n <= 0) return 0;
  if (r === 0) return monthly * n;
  return monthly * ((Math.pow(1 + r, n) - 1) / r);
}

/** What one rupee today is worth after `years` at `annualRate`. */
function grown(amount: number, years: number, annualRate: number): number {
  return amount * Math.pow(1 + annualRate, years);
}

export function ScenarioFacts({
  years,
  annualReturn,
  inflation,
  surplus,
  currency,
}: {
  years: number;
  annualReturn: number;
  inflation: number;
  surplus: number;
  currency: Currency;
}) {
  if (years <= 0) return null;
  const money = (v: number) => formatCompact(v, currency);

  // A round, relatable unit rather than a share of income - the point is the
  // multiple, and a tidy number makes the multiple legible.
  const unit = 5000;
  const unitGrows = futureValueOfMonthly(unit, years, annualReturn);

  // The cost of starting a year late: the same contribution, one year fewer.
  const full = futureValueOfMonthly(unit, years, annualReturn);
  const delayed = futureValueOfMonthly(unit, Math.max(0, years - 1), annualReturn);
  const costOfWaiting = full - delayed;

  // One point of return, over the whole horizon, on the same contribution.
  const atHigherReturn = futureValueOfMonthly(unit, years, annualReturn + 0.01);
  const onePointIsWorth = atHigherReturn - full;

  const lakhThen = grown(100000, years, inflation);

  const facts = [
    {
      key: 'compound',
      headline: money(unitGrows),
      body: (
        <>
          is what <strong>{money(unit)} a month</strong> becomes over your {years.toFixed(0)}-year
          horizon at {(annualReturn * 100).toFixed(1)}% — of which{' '}
          <strong>{money(unitGrows - unit * Math.round(years * 12))}</strong> is growth rather than
          what you put in.
        </>
      ),
    },
    {
      key: 'waiting',
      headline: money(costOfWaiting),
      body: (
        <>
          is what starting that same {money(unit)} a month <strong>one year later</strong> costs you.
          The missing year is the first one, and it is the one that compounds longest.
        </>
      ),
    },
    {
      key: 'return',
      headline: money(onePointIsWorth),
      body: (
        <>
          is what <strong>one extra point of return</strong> is worth on it — which is why the fee
          and allocation levers matter as much as the savings one.
        </>
      ),
    },
    {
      key: 'inflation',
      headline: money(lakhThen),
      body: (
        <>
          is what <strong>{money(100000)} of today's spending</strong> will cost you by then at{' '}
          {(inflation * 100).toFixed(1)}% inflation. Every target on this page is already inflated
          this way.
        </>
      ),
    },
  ];

  return (
    <Card title="Worth knowing" subtitle="Your horizon and your return, not general rules of thumb">
      <ul className="facts">
        {facts.map((f) => (
          <li className="fact" key={f.key}>
            <span className="fact-figure num">{f.headline}</span>
            <span className="fact-body">{f.body}</span>
          </li>
        ))}
      </ul>
      {surplus > 0 && (
        <p className="text-xs text-subtle mt-3">
          You have {money(surplus)} a month uncommitted, so the first figure is reachable{' '}
          {surplus >= unit ? 'today' : 'once a little spending is freed up'}.
        </p>
      )}
    </Card>
  );
}
