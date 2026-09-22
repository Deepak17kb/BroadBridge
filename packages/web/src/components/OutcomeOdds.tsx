import { formatCompact, formatPercent, type Currency, type MonteCarloResult } from '@wealth/shared';

/**
 * What the histogram's shape means, as odds you can state out loud.
 *
 * The chart above shows where 1,500 paths landed; it does not say what that
 * distribution is worth to you. These are read straight off the same run -
 * the percentiles the engine already returns, plus the share of paths that
 * clear the target - so the panel cannot disagree with the bars above it.
 *
 * Framed as "roughly 1 in N" as well as a percentage, because a probability
 * is easier to argue with when it is also a count.
 */
export function OutcomeOdds({
  result,
  currency,
}: {
  result: MonteCarloResult;
  currency: Currency;
}) {
  const money = (v: number) => formatCompact(v, currency);
  const success = result.successProbability;
  // 0% and 100% have no meaningful "1 in N"; everything between does.
  const oneIn = success > 0 && success < 1 ? Math.round(1 / success) : null;
  const spread = result.p90 - result.p10;

  return (
    <div className="odds">
      <div className="odds-head">
        <div>
          <div className="odds-figure num">{formatPercent(success, 0)}</div>
          <div className="odds-caption">
            of {result.paths.toLocaleString()} paths reach the target
            {oneIn ? ` · about 1 in ${oneIn}` : ''}
          </div>
        </div>
        <span className={`badge ${success >= 0.7 ? 'badge-positive' : success >= 0.4 ? 'badge-warning' : 'badge-negative'}`}>
          {success >= 0.7 ? 'On track' : success >= 0.4 ? 'Uncertain' : 'Unlikely'}
        </span>
      </div>

      <hr className="divider" />

      <dl className="odds-rows">
        <div>
          <dt>Bad run (10th)</dt>
          <dd className="num">{money(result.p10)}</dd>
        </div>
        <div>
          <dt>Median</dt>
          <dd className="num strong">{money(result.median)}</dd>
        </div>
        <div>
          <dt>Good run (90th)</dt>
          <dd className="num">{money(result.p90)}</dd>
        </div>
        <div>
          <dt>Spread</dt>
          <dd className="num">{money(spread)}</dd>
        </div>
      </dl>

      <p className="odds-note">
        {success >= 0.7
          ? 'Most paths clear the target, so the plan survives an ordinary run of bad luck.'
          : success >= 0.4
            ? 'The target is reachable but not dependable — the gap between a good and a bad decade decides it.'
            : 'Almost no path reaches the target on this plan. A bigger contribution, more time or a smaller target is what moves this, not a better return.'}
      </p>
    </div>
  );
}
