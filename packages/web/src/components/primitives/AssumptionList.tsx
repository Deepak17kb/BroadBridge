import type { Assumption } from '@wealth/shared';

const SOURCE_LABEL: Record<Assumption['source'], string> = {
  user_input: 'your input',
  market_assumption: 'house view',
  model_default: 'model',
  derived: 'derived',
};

/**
 * The assumptions ledger.
 *
 * Every projection in the platform renders this. Showing where each number came
 * from - the user, a house assumption, a model default, or derived - is what
 * separates an explainable recommendation from a confident-looking guess.
 */
export function AssumptionList({
  assumptions,
  title = 'Assumptions behind this',
  open = false,
}: {
  assumptions: Assumption[];
  title?: string;
  open?: boolean;
}) {
  if (assumptions.length === 0) return null;
  return (
    <details className="disclosure" open={open}>
      <summary>
        {title} ({assumptions.length})
      </summary>
      <div className="disclosure-body">
        <div className="assumptions">
          {assumptions.map((a, i) => (
            <div className="assumption" key={`${a.label}-${i}`}>
              <div className="assumption-label">{a.label}</div>
              <div className="assumption-value">
                {a.value}
                <span className={`source-tag source-${a.source}`}>{SOURCE_LABEL[a.source]}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}
