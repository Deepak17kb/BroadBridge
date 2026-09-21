import { memo, useMemo, useRef, type KeyboardEvent } from 'react';
import {
  formatCompact,
  formatPercent,
  type Currency,
  type Goal,
  type GoalProjection,
} from '@wealth/shared';
import { Badge, ProgressBar } from './ui';

/**
 * The goals beside the goal detail, as one keyboard stop.
 *
 * Tab lands on the selected goal; the arrow keys, Home and End move between
 * goals, and Enter or Space opens the one with focus. Moving focus does not
 * select, because selecting resets the "test a change" sliders.
 */
export function GoalList({
  projections,
  goals,
  selectedId,
  currency,
  onSelect,
}: {
  projections: GoalProjection[];
  goals: Goal[];
  selectedId: string | null;
  currency: Currency;
  onSelect: (goalId: string) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const goalsById = useMemo(() => new Map(goals.map((g) => [g.id, g])), [goals]);
  // With nothing selected the first goal takes the tab stop, or the list has none.
  const tabStop = projections.some((p) => p.goalId === selectedId)
    ? selectedId
    : projections[0]?.goalId;

  function moveFocus(event: KeyboardEvent<HTMLUListElement>) {
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.goal-item') ?? [])];
    const current = items.findIndex((item) => item === document.activeElement);
    if (current < 0) return;
    const last = items.length - 1;
    const next =
      event.key === 'ArrowDown'
        ? Math.min(current + 1, last)
        : event.key === 'ArrowUp'
          ? Math.max(current - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <ul className="goal-list" aria-label="Goals" ref={listRef} onKeyDown={moveFocus}>
      {projections.map((p) => (
        <GoalListItem
          key={p.goalId}
          projection={p}
          goal={goalsById.get(p.goalId)}
          active={p.goalId === selectedId}
          focusable={p.goalId === tabStop}
          currency={currency}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

export const GoalListItem = memo(function GoalListItem({
  projection: p,
  goal,
  active,
  focusable,
  currency,
  onSelect,
}: {
  projection: GoalProjection;
  goal: Goal | undefined;
  active: boolean;
  focusable: boolean;
  currency: Currency;
  onSelect: (goalId: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`goal-item ${active ? 'selected' : ''}`.trim()}
        aria-current={active ? 'true' : undefined}
        tabIndex={focusable ? 0 : -1}
        onClick={() => onSelect(p.goalId)}
      >
        <span className="row-between">
          <span className="text-sm strong truncate">{p.goalName}</span>
          <Badge tone={p.onTrack ? 'positive' : 'negative'}>{formatPercent(p.fundedRatio, 0)}</Badge>
        </span>
        <ProgressBar value={p.fundedRatio} label={`${p.goalName} funding`} />
        <span className="goal-item-meta text-xs text-subtle">
          {formatCompact(p.inflatedTarget, currency)} needed in {p.yearsToGoal.toFixed(1)}y ·{' '}
          {formatCompact(goal?.monthlyContribution ?? 0, currency)}/mo
          {goal?.priority === 'must_have' && ' · must have'}
        </span>
      </button>
    </li>
  );
});
