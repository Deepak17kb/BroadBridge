import { useEffect, useState } from 'react';
import { formatPercent, type AssetClass } from '@wealth/shared';
import { api } from '../lib/api';
import { AllocationBar } from './charts/Charts';
import { Badge } from './ui';

/**
 * The five model portfolios with what each is expected to return and what that
 * costs in volatility.
 *
 * Shown in three places - Portfolio, the Assumptions ledger and the Scenario
 * Lab - for the same reason each time: a recommended allocation asserted on its
 * own is a claim, while the same allocation shown beside the four it was chosen
 * over is an argument. It lives here rather than being copied per page so the
 * three can never drift apart.
 *
 * The rows come from `GET /api/plan/:id/allocation`, which computes them from
 * *this profile's* assumptions - so a user who edits an expected return in the
 * ledger sees every portfolio re-priced, not just their own.
 */

export interface LadderRow {
  bucket: string;
  weights: Record<string, number>;
  expectedReturnPct: number;
  volatilityPct: number;
}

/**
 * Loads the ladder for a profile.
 *
 * `refreshKey` is any value the caller changes when the rows should be fetched
 * again - the Assumptions page passes its save state, because the endpoint
 * reads the *stored* profile and a freshly edited assumption is not stored yet.
 */
export function useRiskLadder(profileId: string, refreshKey?: unknown): LadderRow[] {
  const [rows, setRows] = useState<LadderRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .allocationLadder(profileId)
      .then((r) => !cancelled && setRows(r))
      // The ladder is context, never the only thing on the page: a failure
      // hides the card rather than breaking the screen around it.
      .catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
  }, [profileId, refreshKey]);

  return rows;
}

export function equityShare(weights: Record<string, number>): number {
  return (
    (weights.equity_domestic ?? 0) + (weights.equity_international ?? 0) + (weights.reit ?? 0)
  );
}

export function RiskLadder({
  rows,
  yourBucket,
  selectedBucket,
  onSelect,
  footnote,
}: {
  rows: LadderRow[];
  /** The bucket the profile's own risk score lands on, badged as "yours". */
  yourBucket?: string;
  /** Highlighted as the active choice when the ladder is being used as a control. */
  selectedBucket?: string;
  /** Supplying this makes each row selectable. */
  onSelect?: (row: LadderRow) => void;
  footnote?: React.ReactNode;
}) {
  if (rows.length === 0) return null;

  return (
    <>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Risk level</th>
              <th className="right">Expected return</th>
              <th className="right">Volatility</th>
              <th className="right">Equity share</th>
              <th>Mix</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isYours = row.bucket === yourBucket;
              const isSelected = row.bucket === selectedBucket;
              return (
                <tr
                  key={row.bucket}
                  className={isSelected ? 'is-selected' : isYours ? 'is-highlighted' : undefined}
                >
                  <td>
                    {onSelect ? (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => onSelect(row)}
                        aria-pressed={isSelected}
                      >
                        {row.bucket}
                      </button>
                    ) : (
                      row.bucket
                    )}{' '}
                    {isYours && <Badge tone="accent">yours</Badge>}
                  </td>
                  <td className="right num">{formatPercent(row.expectedReturnPct)}</td>
                  <td className="right num">{formatPercent(row.volatilityPct)}</td>
                  <td className="right num">{formatPercent(equityShare(row.weights), 0)}</td>
                  <td className="cell-wide">
                    <AllocationBar weights={row.weights as Record<AssetClass, number>} label="" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footnote && (
        <p className="text-xs text-subtle mt-3">{footnote}</p>
      )}
    </>
  );
}
