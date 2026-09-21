import {
  formatCompact,
  formatPercent,
  type Currency,
  type SurplusAllocation,
} from '@wealth/shared';
import { AssumptionList, Badge, Callout, Card, Icon } from './ui';

/**
 * Where the surplus should go, and what that costs the goals that lose.
 *
 * The rest of the platform reports each goal's gap on its own, and those gaps
 * routinely add up to more than the household earns. This is the screen that
 * admits goals compete, so the design rule is that the *cost* is as prominent as
 * the recommendation: every starved goal states its delay in years, because
 * "your second home arrives four years later" is a sentence someone can decide
 * about and "short by 41 lakh" is not.
 */

const PRIORITY_TONE = {
  must_have: 'negative',
  important: 'warning',
  aspirational: 'info',
} as const;

export function SurplusSplit({
  result,
  currency,
  onApply,
  applied,
}: {
  result: SurplusAllocation;
  currency: Currency;
  onApply: () => void;
  applied: boolean;
}) {
  const money = (v: number) => formatCompact(v, currency);
  const totalAllocated = result.allocations.reduce((a, x) => a + x.allocated, 0);

  if (result.allocations.length === 0) return null;

  return (
    <Card
      title="Where your surplus should go"
      subtitle="Your goals compete for one pool of money — this is the split, and what it costs"
      actions={
        result.available > 0 ? (
          <button className="btn btn-sm btn-primary" onClick={onApply} disabled={applied}>
            {applied ? (
              <>
                <Icon name="check" /> Applied
              </>
            ) : (
              'Apply this allocation'
            )}
          </button>
        ) : undefined
      }
    >
      {result.available <= 0 ? (
        <Callout tone="warning">{result.rationale}</Callout>
      ) : (
        <>
          <p className="text-sm text-muted">{result.rationale}</p>

          {/* One bar, so the competition is visible before any number is read. */}
          <div className="stack-sm">
            <div className="alloc-bar" aria-hidden="true">
              {result.allocations
                .filter((a) => a.allocated > 0)
                .map((a, i) => (
                  <div
                    key={a.goalId}
                    className="alloc-seg"
                    style={{
                      width: `${(a.allocated / Math.max(result.available, 1)) * 100}%`,
                      background: `var(--series-${(i % 6) + 1})`,
                    }}
                    title={`${a.goalName}: ${money(a.allocated)}`}
                  />
                ))}
              {result.unallocated > 0 && (
                <div
                  className="alloc-seg alloc-seg-free"
                  style={{ width: `${(result.unallocated / Math.max(result.available, 1)) * 100}%` }}
                  title={`Unallocated: ${money(result.unallocated)}`}
                />
              )}
            </div>
            <div className="row-between wrap text-xs text-subtle">
              <span>
                {money(totalAllocated)} of {money(result.available)} a month allocated
              </span>
              {result.toRetirementGap > 0 && (
                <span>{money(result.toRetirementGap)} to the retirement gap</span>
              )}
            </div>
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Goal</th>
                  <th>Priority</th>
                  <th className="right">Needs</th>
                  <th className="right">Gets</th>
                  <th className="right">Funded</th>
                  <th>What it costs you</th>
                </tr>
              </thead>
              <tbody>
                {result.allocations.map((a) => {
                  const starved = result.starved.find((s) => s.goalId === a.goalId);
                  return (
                    <tr key={a.goalId}>
                      <td>
                        {a.goalName}{' '}
                        {a.nearTerm && (
                          <span title="Funds ahead of longer-horizon goals of the same priority">
                            <Badge tone="accent">due soon</Badge>
                          </span>
                        )}
                      </td>
                      <td>
                        <Badge tone={PRIORITY_TONE[a.priority]}>
                          {a.priority.replace('_', ' ')}
                        </Badge>
                      </td>
                      <td className="right num">{money(a.requiredMonthly)}</td>
                      <td className="right num strong">{money(a.allocated)}</td>
                      <td className="right num">
                        <span className="row gap-1 justify-end">
                          {a.onTrack && (
                            <Icon name="check" size={12} label="On track" className="text-positive" />
                          )}
                          {formatPercent(a.resultingFundedRatio, 0)}
                        </span>
                      </td>
                      <td className="text-sm text-muted cell-wide">
                        {!starved
                          ? 'Fully funded on this split.'
                          : starved.yearsDelayIfUnfunded === null
                            ? `Not reached at all on ${money(a.allocated)} a month.`
                            : `Arrives about ${starved.yearsDelayIfUnfunded} ${
                                starved.yearsDelayIfUnfunded === 1 ? 'year' : 'years'
                              } later — it is short ${money(starved.unmetMonthly)} a month.`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Callout tone="info">
            Applying this rewrites your monthly contributions to the split above — some goals go up,
            others come down. Nothing else about your plan changes, and you can edit any goal
            afterwards.
          </Callout>
        </>
      )}

      <AssumptionList assumptions={result.assumptions} title="How this split was decided" />
    </Card>
  );
}
