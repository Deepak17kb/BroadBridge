import { useId, useState } from 'react';
import {
  formatCompact,
  formatPercent,
  type ActionImpact,
  type Currency,
} from '@wealth/shared';
import { AssumptionList, Badge, Card, SkeletonStats } from './ui';

/**
 * What following the advice is worth, as the first thing on the dashboard.
 *
 * The platform could always compute this and never showed it. The design rule
 * for this card is that it must survive being checked: every figure is a
 * before/after pair rather than a lone number, the per-action breakdown is
 * marginal so the parts sum to the whole, and everything the headline does *not*
 * include is one click away rather than omitted. A "value created" number that
 * quietly counts advice the platform cannot carry out - or a plan the user
 * cannot fund - is worse than showing nothing.
 */

function Delta({
  before,
  after,
  format,
  betterWhen = 'higher',
}: {
  before: number;
  after: number;
  format: (v: number) => string;
  betterWhen?: 'higher' | 'lower';
}) {
  const changed = Math.abs(after - before) > 1e-9;
  const better = betterWhen === 'higher' ? after > before : after < before;
  /*
   * The outcome is the headline; where it came from is a footnote under it.
   *
   * Side by side, two currency figures and an arrow ran past the tile - the
   * pair wrapped, a bare "Cr" landed on the next row beside a different
   * number, and the taller tile knocked the whole cluster out of alignment.
   * Stacking is what makes the width independent of how long the figures are,
   * and it puts the size on the number the reader actually wants.
   */
  if (!changed) return <span className="num">{format(before)}</span>;

  return (
    <span className="delta-stack">
      <span className={`num nowrap ${better ? 'text-positive' : 'text-negative'}`}>
        {format(after)}
      </span>
      <span className="delta-from num nowrap">from {format(before)}</span>
    </span>
  );
}

export function ImpactHero({
  impact,
  currency,
  loading,
}: {
  impact: ActionImpact | null;
  currency: Currency;
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const breakdownId = useId();

  if (loading) {
    return (
      <section className="card card-primary" aria-busy="true">
        <p className="text-sm text-muted" role="status">
          Working out what your next actions are worth…
        </p>
        <SkeletonStats />
      </section>
    );
  }
  if (!impact) return null;

  const { before, after, applied, notModelled } = impact;
  const money = (v: number) => formatCompact(v, currency);

  if (impact.noop) {
    return (
      <Card title="Nothing left to automate" subtitle="Your plan already passes every check the platform can act on">
        <p className="text-sm text-muted">
          The remaining {notModelled.length} recommendations need you rather than the platform —
          buying cover, refinancing, opening an account. They are listed on the Actions page with
          the arithmetic behind each one.
        </p>
      </Card>
    );
  }

  const unaffordable = notModelled.filter((n) => n.why.startsWith('Worth doing'));

  return (
    <Card
      variant="primary"
      title={`Following your top ${applied.length} action${applied.length === 1 ? '' : 's'}`}
      subtitle="Applied in order, each credited only with what it adds on top of the ones above it"
      actions={
        <button
          className="btn btn-sm"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={open ? breakdownId : undefined}
        >
          {open ? 'Hide the breakdown' : 'Show the breakdown'}
        </button>
      }
    >
      <div className="grid grid-4">
        <div className="stat">
          <div className="stat-label">Wellness score</div>
          <div className="stat-value">
            <Delta before={before.wellnessScore} after={after.wellnessScore} format={(v) => String(v)} />
          </div>
          <div className="text-xs text-subtle">
            grade {before.wellnessGrade}
            {after.wellnessGrade !== before.wellnessGrade && ` → ${after.wellnessGrade}`}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Retirement funded</div>
          <div className="stat-value">
            <Delta
              before={before.retirementFundedPct}
              after={after.retirementFundedPct}
              format={(v) => formatPercent(v, 0)}
            />
          </div>
          <div className="text-xs text-subtle">of the corpus you need</div>
        </div>
        <div className="stat">
          <div className="stat-label">Median corpus</div>
          <div className="stat-value">
            <Delta
              before={before.medianCorpusAtRetirement}
              after={after.medianCorpusAtRetirement}
              format={money}
            />
          </div>
          <div className="text-xs text-subtle">p50 of {impact.paths} seeded paths</div>
        </div>
        <div className="stat">
          <div className="stat-label">Emergency cover</div>
          <div className="stat-value">
            <Delta
              before={before.emergencyFundMonths}
              after={after.emergencyFundMonths}
              format={(v) => `${v.toFixed(1)}m`}
            />
          </div>
          <div className="text-xs text-subtle">months of expenses</div>
        </div>
      </div>

      {before.totalInterestPaid > 0 && (
        <p className="text-sm text-muted">
          Debt is unchanged by these actions: {money(before.totalInterestPaid)} of interest over{' '}
          {before.monthsToDebtFree} months either way. Clearing it faster is on the Actions page, and
          it is not something the platform can do on your behalf.
        </p>
      )}

      {open && (
        <div id={breakdownId} className="stack">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Action</th>
                  <th className="right">Wellness</th>
                  <th className="right">Retirement funded</th>
                  <th className="right">Median corpus</th>
                  <th className="right">Costs per month</th>
                </tr>
              </thead>
              <tbody>
                {applied.map((a) => (
                  <tr key={a.id}>
                    <td>{a.title}</td>
                    <td className="right num">
                      {a.marginal.wellnessScore >= 0 ? '+' : ''}
                      {a.marginal.wellnessScore}
                    </td>
                    <td className="right num">
                      {a.marginal.retirementFundedPct >= 0 ? '+' : ''}
                      {formatPercent(a.marginal.retirementFundedPct, 1)}
                    </td>
                    <td className="right num">
                      {a.marginal.medianCorpusAtRetirement >= 0 ? '+' : ''}
                      {money(a.marginal.medianCorpusAtRetirement)}
                    </td>
                    <td className="right num">
                      {a.marginal.monthlySurplus === 0
                        ? '—'
                        : money(Math.abs(a.marginal.monthlySurplus))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {unaffordable.length > 0 && (
            <section>
              <h3 className="subhead">Excluded because your surplus will not carry them</h3>
              <ul className="bullets text-sm text-muted">
                {unaffordable.map((n) => (
                  <li key={n.id}>
                    <span className="strong">{n.title}</span> — {n.why}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className="subhead">Not counted here ({notModelled.length - unaffordable.length})</h3>
            <p className="text-sm text-muted">
              The rest of the ranked list needs you rather than the platform — buying a policy,
              refinancing, opening an account.{' '}
              <Badge>{applied.length} counted</Badge>{' '}
              <Badge tone="warning">{notModelled.length} not</Badge>
            </p>
          </section>

          <AssumptionList assumptions={impact.assumptions} title="What this figure assumes" />
        </div>
      )}
    </Card>
  );
}
