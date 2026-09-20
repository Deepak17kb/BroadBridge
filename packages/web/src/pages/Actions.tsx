import { useMemo, useState } from 'react';
import {
  ASSET_CLASSES,
  formatCompact,
  type ActionCategory,
  type NextBestAction,
} from '@wealth/shared';
import { useProfile, useLoadedProfile } from '../state/ProfileContext';
import { AssumptionList, Badge, Callout, Card, Empty, Stat } from '../components/ui';

/**
 * The action list.
 *
 * Every action carries four things a recommendation needs to be trustworthy:
 * why it applies to this user, what it is worth in money, what it assumed, and
 * a button that actually does it. The last one matters most - advice you have
 * to re-enter by hand somewhere else is advice most people never take.
 */

const CATEGORY_LABELS: Record<ActionCategory, string> = {
  protection: 'Protection',
  debt: 'Debt',
  savings: 'Saving',
  investing: 'Investing',
  tax: 'Tax',
  goals: 'Goals',
  efficiency: 'Efficiency',
};

const CATEGORY_TONE: Record<ActionCategory, 'negative' | 'warning' | 'info' | 'accent' | 'positive'> = {
  protection: 'negative',
  debt: 'negative',
  savings: 'positive',
  investing: 'info',
  tax: 'accent',
  goals: 'warning',
  efficiency: 'info',
};

export function Actions() {
  const { profile, snapshot } = useLoadedProfile();
  const { updateProfile } = useProfile();
  const { currency } = profile;

  const [filter, setFilter] = useState<ActionCategory | 'all'>('all');
  const [expanded, setExpanded] = useState<string | null>(snapshot.actions[0]?.id ?? null);
  const [applied, setApplied] = useState<string[]>([]);

  const categories = useMemo(
    () => [...new Set(snapshot.actions.map((a) => a.category))],
    [snapshot.actions],
  );
  const visible = filter === 'all' ? snapshot.actions : snapshot.actions.filter((a) => a.category === filter);

  const totalCurrencyImpact = snapshot.actions
    .filter((a) => a.impact.unit === 'currency')
    .reduce((acc, a) => acc + a.impact.value, 0);

  /**
   * Applies an action's mutation to the profile.
   *
   * These are real edits, not a simulation - the dashboard, every projection
   * and the assistant's next answer all change as a result, because they all
   * read the same profile.
   */
  function apply(action: NextBestAction) {
    const mutation = action.apply;
    if (!mutation) return;

    updateProfile((draft) => {
      switch (mutation.type) {
        case 'increase_goal_contribution': {
          const goal = draft.goals.find((g) => g.id === mutation.goalId);
          if (goal) goal.monthlyContribution += mutation.amount;
          break;
        }
        case 'set_emergency_fund':
          draft.liquidSavings = Math.max(draft.liquidSavings, mutation.amount);
          break;
        case 'set_allocation':
        case 'rebalance_to_target': {
          // Rebalancing is modelled by restating the holdings at the target
          // weights, keeping the total value fixed. Real trades have costs and
          // tax consequences the engine deliberately does not pretend to know.
          const weights =
            mutation.type === 'set_allocation' ? mutation.weights : snapshot.recommendedAllocation;
          const investable = draft.holdings.reduce((acc, h) => acc + h.units * h.price, 0);
          if (investable <= 0) break;
          const existing = new Map(draft.holdings.map((h) => [h.assetClass, h] as const));
          draft.holdings = ASSET_CLASSES.filter((ac) => (weights[ac] ?? 0) > 0.001).map((ac) => {
            const target = (weights[ac] ?? 0) * investable;
            const current = existing.get(ac);
            return current
              ? { ...current, units: 1, price: target }
              : {
                  id: `h-${ac}-${Date.now()}`,
                  symbol: ac.toUpperCase().slice(0, 8),
                  name: `${ac.replace(/_/g, ' ')} allocation`,
                  assetClass: ac,
                  units: 1,
                  price: target,
                  costBasis: target,
                  instrumentKind: 'fund' as const,
                  expenseRatioPct: 0.002,
                };
          });
          break;
        }
      }
    });
    setApplied((a) => [...a, action.id]);
  }

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Next Best Actions</h1>
        <p>
          Ranked by impact against effort and urgency, and ordered by the planning waterfall — protect
          first, then clear expensive debt, then fund goals, then optimise. Each one shows its own
          arithmetic and the assumptions behind it.
        </p>
      </header>

      <div className="grid grid-4">
        <Card>
          <Stat label="Actions identified" value={snapshot.actions.length} meta="from 13 rule checks" />
        </Card>
        <Card>
          <Stat
            label="Quantified upside"
            value={formatCompact(totalCurrencyImpact, currency)}
            meta="sum of the money-denominated impacts"
            tone="positive"
          />
        </Card>
        <Card>
          <Stat
            label="Low effort"
            value={snapshot.actions.filter((a) => a.effort === 'low').length}
            meta="can be done this week"
          />
        </Card>
        <Card>
          <Stat
            label="Urgent"
            value={snapshot.actions.filter((a) => a.priorityScore >= 70).length}
            meta="priority score 70 or above"
            tone={snapshot.actions.some((a) => a.priorityScore >= 70) ? 'warning' : 'positive'}
          />
        </Card>
      </div>

      {applied.length > 0 && (
        <Callout tone="positive">
          {applied.length} action{applied.length === 1 ? '' : 's'} applied to your plan. Every
          projection on the platform has been recalculated — the list below has already re-ranked
          itself.
        </Callout>
      )}

      <div className="row-wrap">
        <button
          className={`btn btn-sm ${filter === 'all' ? 'btn-primary' : ''}`}
          onClick={() => setFilter('all')}
        >
          All ({snapshot.actions.length})
        </button>
        {categories.map((c) => (
          <button
            key={c}
            className={`btn btn-sm ${filter === c ? 'btn-primary' : ''}`}
            onClick={() => setFilter(c)}
          >
            {CATEGORY_LABELS[c]} ({snapshot.actions.filter((a) => a.category === c).length})
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <Card>
          <Empty
            title="Nothing outstanding here"
            message="No actions in this category. Your plan passes every check the engine runs for it."
          />
        </Card>
      ) : (
        <div className="stack">
          {visible.map((action, index) => {
            const isOpen = expanded === action.id;
            const wasApplied = applied.includes(action.id);
            return (
              <article className="action" key={action.id}>
                <div className="action-top">
                  <span className="action-rank">{index + 1}</span>
                  <div className="action-body">
                    <div className="action-title">{action.title}</div>
                    <p className="action-why">{action.why}</p>
                    <div className="row-wrap" style={{ marginTop: 9 }}>
                      <Badge tone={CATEGORY_TONE[action.category]}>{CATEGORY_LABELS[action.category]}</Badge>
                      <Badge tone={action.effort === 'low' ? 'positive' : action.effort === 'medium' ? 'warning' : 'negative'}>
                        {action.effort} effort
                      </Badge>
                      <Badge>priority {Math.round(action.priorityScore)}</Badge>
                      {wasApplied && <Badge tone="positive">applied</Badge>}
                    </div>
                  </div>
                  <div className="action-impact">
                    <div className="action-impact-value">
                      {action.impact.unit === 'currency'
                        ? formatCompact(action.impact.value, currency)
                        : action.impact.unit === 'percent'
                          ? `${action.impact.value}%`
                          : `${action.impact.value} ${action.impact.unit}`}
                    </div>
                    <div className="action-impact-label">{action.impact.metric}</div>
                  </div>
                </div>

                <div className="action-detail">
                  <div className="row-between" style={{ marginBottom: isOpen ? 12 : 0 }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => setExpanded(isOpen ? null : action.id)}>
                      {isOpen ? 'Hide detail' : 'How do I do this?'}
                    </button>
                    {action.apply && (
                      <button
                        className={`btn btn-sm ${wasApplied ? '' : 'btn-primary'}`}
                        onClick={() => apply(action)}
                        disabled={wasApplied}
                        title={
                          wasApplied
                            ? 'Already applied to your plan'
                            : 'Applies this change to your plan and recalculates everything'
                        }
                      >
                        {wasApplied ? '✓ Applied' : 'Apply to my plan'}
                      </button>
                    )}
                  </div>

                  {isOpen && (
                    <div className="stack-sm">
                      <div>
                        <div className="stat-label" style={{ marginBottom: 7 }}>
                          Steps
                        </div>
                        <ol className="action-steps">
                          {action.steps.map((step, i) => (
                            <li key={i}>{step}</li>
                          ))}
                        </ol>
                      </div>
                      <AssumptionList assumptions={action.assumptions} title="What this calculation assumed" />
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Card title="How actions are ranked" subtitle="The ordering is a rule, not a model output">
        <p className="text-sm text-muted">
          Actions come from a deterministic rule engine, not from the language model. Two users with
          the same balance sheet get the same list in the same order, and every impact figure can be
          reproduced from the assumptions shown beside it. The AI assistant explains and prioritises
          these actions in conversation — it never invents one.
        </p>
        <p className="text-sm text-muted">
          Ordering follows the standard planning waterfall rather than raw impact. A rupee of
          emergency fund is worth more than a rupee of expected return when there is no buffer at
          all, so protection and expensive debt outrank optimisation even when the optimisation shows
          a larger number.
        </p>
      </Card>
    </div>
  );
}
