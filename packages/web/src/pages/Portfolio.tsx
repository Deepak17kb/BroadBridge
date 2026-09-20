import { useMemo, useState } from 'react';
import {
  ASSET_LABELS,
  formatCompact,
  formatPercent,
  planDebtPayoff,
  type AssetClass,
} from '@wealth/shared';
import { useLoadedProfile, useProfile } from '../state/ProfileContext';
import { AssumptionList, Badge, Callout, Card, Empty, MoneyInput, Slider, Stat } from '../components/ui';
import { RiskLadder, useRiskLadder } from '../components/RiskLadder';
import { AllocationBar, AllocationLegend, DriftChart } from '../components/charts/Charts';

/**
 * Portfolio and balance sheet.
 *
 * Three things a holdings screen usually gets wrong and this one does not:
 * volatility is computed from the full covariance matrix rather than a weighted
 * average of the parts, concentration is measured on individual securities
 * rather than on fund positions, and the risk ladder is shown so the
 * recommended mix can be compared against the alternatives rather than simply
 * asserted.
 */
export function Portfolio() {
  const { profile, snapshot } = useLoadedProfile();
  const { updateProfile } = useProfile();
  const { currency } = profile;
  const { portfolio } = snapshot;

  const ladder = useRiskLadder(profile.id);
  const [extraDebtPayment, setExtraDebtPayment] = useState(0);

  const debtPlans = useMemo(() => {
    if (profile.liabilities.length === 0) return null;
    return {
      avalanche: planDebtPayoff(profile, 'avalanche', extraDebtPayment),
      snowball: planDebtPayoff(profile, 'snowball', extraDebtPayment),
    };
  }, [profile, extraDebtPayment]);

  const totalDebt = profile.liabilities.reduce((a, l) => a + l.outstanding, 0);

  return (
    <div className="stack">
      <header className="page-head">
        <h1>Portfolio</h1>
        <p>
          What you hold, what it is expected to do, and where it has drifted from the mix your risk
          profile supports.
        </p>
      </header>

      <div className="grid grid-4">
        <Card>
          <Stat
            label="Portfolio value"
            value={formatCompact(portfolio.totalValue, currency)}
            meta={`${profile.holdings.length} holdings plus cash`}
          />
        </Card>
        <Card>
          <Stat
            label="Expected return"
            value={formatPercent(portfolio.expectedReturnPct)}
            meta="per year, long-run planning figure"
          />
        </Card>
        <Card>
          <Stat
            label="Volatility"
            value={formatPercent(portfolio.volatilityPct)}
            meta="annual standard deviation"
          />
        </Card>
        <Card>
          <Stat
            label="Risk-adjusted return"
            value={portfolio.sharpeRatio.toFixed(2)}
            meta={`Sharpe, against a ${formatPercent(snapshot.assumptions.riskFreePct, 1)} risk-free rate`}
            tone={portfolio.sharpeRatio >= 0.4 ? 'positive' : 'warning'}
          />
        </Card>
      </div>

      {portfolio.totalValue === 0 ? (
        <Card>
          <Empty
            title="No holdings recorded"
            message="Add what you hold below and the engine will analyse the allocation, risk, fees and drift."
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-sidebar">
            <Card
              title="Allocation versus target"
              subtitle={`Your ${snapshot.risk.bucket} profile over a ${snapshot.retirement.yearsToRetirement}-year horizon`}
            >
              <div className="stack-sm">
                <AllocationBar
                  weights={portfolio.weights}
                  label="What you hold today"
                  total={portfolio.totalValue}
                  currency={currency}
                />
                <AllocationBar
                  weights={snapshot.recommendedAllocation}
                  label="Recommended mix"
                  total={portfolio.totalValue}
                  currency={currency}
                />
                <AllocationLegend weights={portfolio.weights} />
              </div>

              <div className="divider" style={{ margin: '16px 0' }} />

              <div className="card-title" style={{ marginBottom: 4 }}>
                Out of position
              </div>
              <div className="card-sub" style={{ marginBottom: 12 }}>
                Which way and how far each asset class sits from where it should be
              </div>
              <DriftChart portfolio={portfolio} currency={currency} />

              {portfolio.rebalanceTrades.length > 0 && (
                <>
                  <div className="divider" style={{ margin: '16px 0' }} />
                  <div className="card-title" style={{ marginBottom: 10 }}>
                    Trades that would close the gap
                  </div>
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>Action</th>
                          <th>Asset class</th>
                          <th className="right">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {portfolio.rebalanceTrades.map((t) => (
                          <tr key={t.assetClass}>
                            <td>
                              <Badge tone={t.action === 'buy' ? 'info' : 'warning'}>{t.action}</Badge>
                            </td>
                            <td>{ASSET_LABELS[t.assetClass]}</td>
                            <td className="right num">{formatCompact(t.amount, currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <Callout tone="info">
                    Direct new contributions at the underweight classes before selling anything —
                    same result, no realised gains. Transaction costs and capital gains tax are not
                    modelled here.
                  </Callout>
                </>
              )}

              <AssumptionList assumptions={portfolio.assumptions} title="How these figures were computed" />
            </Card>

            <div className="stack">
              <Card title="Diversification" subtitle="Measured three ways, because they fail independently">
                <div className="stack-sm">
                  <div className="row-between">
                    <span className="text-sm">Diversification score</span>
                    <span className="text-sm num strong">{portfolio.diversificationScore}/100</span>
                  </div>
                  <div className="bar">
                    <div
                      className={`bar-fill ${portfolio.diversificationScore >= 70 ? 'positive' : portfolio.diversificationScore >= 45 ? 'warning' : 'negative'}`}
                      style={{ width: `${portfolio.diversificationScore}%` }}
                    />
                  </div>
                  <div className="divider" />
                  <div className="row-between">
                    <span className="text-sm text-muted">Effective positions</span>
                    <span className="text-sm num">{portfolio.effectivePositions}</span>
                  </div>
                  <div className="row-between">
                    <span className="text-sm text-muted">Largest holding</span>
                    <span className="text-sm num">
                      {portfolio.largestPosition
                        ? `${formatPercent(portfolio.largestPosition.weight, 0)}`
                        : '—'}
                    </span>
                  </div>
                  <div className="row-between">
                    <span className="text-sm text-muted">Largest single stock</span>
                    <span className={`text-sm num ${(portfolio.largestSingleSecurity?.weight ?? 0) > 0.15 ? 'text-warning' : ''}`}>
                      {portfolio.largestSingleSecurity
                        ? formatPercent(portfolio.largestSingleSecurity.weight, 0)
                        : 'none held'}
                    </span>
                  </div>
                  <p className="text-xs text-subtle" style={{ marginTop: 4 }}>
                    Only individual securities count toward concentration risk. A large index-fund or
                    provident-fund position is diversified internally, so flagging it would be noise.
                  </p>
                  {portfolio.largestSingleSecurity && portfolio.largestSingleSecurity.weight > 0.15 && (
                    <Callout tone="warning">
                      <strong>{portfolio.largestSingleSecurity.name}</strong> is{' '}
                      {formatPercent(portfolio.largestSingleSecurity.weight, 0)} of your invested
                      assets. If it fell by half, your whole portfolio would drop{' '}
                      {formatPercent(portfolio.largestSingleSecurity.weight / 2, 0)} — risk you are
                      not compensated for.
                    </Callout>
                  )}
                </div>
              </Card>

              <Card title="Costs" subtitle="The only return driver you control with certainty">
                <Stat
                  label="Blended expense ratio"
                  value={`${(portfolio.blendedExpenseRatioPct * 100).toFixed(2)}%`}
                  meta={`About ${formatCompact(portfolio.blendedExpenseRatioPct * portfolio.totalValue, currency)} a year at today's balance`}
                  tone={portfolio.blendedExpenseRatioPct > 0.01 ? 'negative' : portfolio.blendedExpenseRatioPct > 0.006 ? 'warning' : 'positive'}
                />
                <p className="text-xs text-muted" style={{ marginTop: 11 }}>
                  Fees compound against you exactly as returns compound for you, and unlike returns
                  they are certain. Over 25 years the difference between 0.2% and 1.8% consumes
                  roughly a third of the final corpus.
                </p>
              </Card>

              <Card title="Unrealised position" subtitle="Against what you paid">
                <Stat
                  label="Gain since purchase"
                  value={formatCompact(portfolio.unrealisedGain, currency)}
                  tone={portfolio.unrealisedGain >= 0 ? 'positive' : 'negative'}
                  meta="Tax on realising this is not modelled"
                />
              </Card>
            </div>
          </div>

          {ladder.length > 0 && (
            <Card
              title="The risk ladder"
              subtitle="What each risk level is expected to return, and what it costs in volatility"
            >
              <RiskLadder
                rows={ladder}
                yourBucket={snapshot.risk.bucket}
                footnote="Higher expected return always costs volatility — that is the trade, and no mix escapes it. Your row is chosen by the lower of your willingness and your ability to take risk."
              />
            </Card>
          )}

          <Card
            title="Holdings"
            subtitle="Edit any row and every projection on the platform updates"
            actions={
              <button
                className="btn btn-sm"
                onClick={() =>
                  updateProfile((d) =>
                    d.holdings.push({
                      id: `h-${Date.now()}`,
                      symbol: 'NEW',
                      name: 'New holding',
                      assetClass: 'equity_domestic',
                      units: 1,
                      price: 0,
                      costBasis: 0,
                      instrumentKind: 'fund',
                    }),
                  )
                }
              >
                + Add holding
              </button>
            }
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Asset class</th>
                    <th>Type</th>
                    <th className="right">Value</th>
                    <th className="right">Cost</th>
                    <th className="right">Gain</th>
                    <th className="right">Fee</th>
                    <th className="right">Weight</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {profile.holdings.map((h, i) => {
                    const value = h.units * h.price;
                    const gain = value - h.costBasis;
                    return (
                      <tr key={h.id}>
                        <td>
                          <input
                            className="input"
                            style={{ minWidth: 130 }}
                            value={h.name}
                            aria-label="Holding name"
                            onChange={(e) => updateProfile((d) => void (d.holdings[i]!.name = e.target.value))}
                          />
                        </td>
                        <td>
                          <select
                            className="select"
                            style={{ minWidth: 128 }}
                            value={h.assetClass}
                            aria-label="Asset class"
                            onChange={(e) =>
                              updateProfile(
                                (d) => void (d.holdings[i]!.assetClass = e.target.value as AssetClass),
                              )
                            }
                          >
                            {Object.entries(ASSET_LABELS).map(([k, label]) => (
                              <option key={k} value={k}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select
                            className="select"
                            style={{ minWidth: 100 }}
                            value={h.instrumentKind ?? 'fund'}
                            aria-label="Instrument type"
                            onChange={(e) =>
                              updateProfile(
                                (d) =>
                                  void (d.holdings[i]!.instrumentKind = e.target.value as
                                    | 'fund'
                                    | 'security'
                                    | 'deposit'),
                              )
                            }
                          >
                            <option value="fund">Fund</option>
                            <option value="security">Single stock</option>
                            <option value="deposit">Deposit</option>
                          </select>
                        </td>
                        <td className="right" style={{ minWidth: 118 }}>
                          <MoneyInput
                            value={value}
                            currency={currency}
                            step={10000}
                            onChange={(v) =>
                              updateProfile((d) => {
                                d.holdings[i]!.units = 1;
                                d.holdings[i]!.price = v;
                              })
                            }
                          />
                        </td>
                        <td className="right" style={{ minWidth: 118 }}>
                          <MoneyInput
                            value={h.costBasis}
                            currency={currency}
                            step={10000}
                            onChange={(v) => updateProfile((d) => void (d.holdings[i]!.costBasis = v))}
                          />
                        </td>
                        <td className={`right num ${gain >= 0 ? 'text-positive' : 'text-negative'}`}>
                          {gain >= 0 ? '+' : '-'}
                          {formatCompact(Math.abs(gain), currency)}
                        </td>
                        <td className="right">
                          <input
                            className="input num"
                            type="number"
                            style={{ width: 74 }}
                            min={0}
                            max={5}
                            step={0.05}
                            aria-label="Expense ratio percent"
                            value={((h.expenseRatioPct ?? 0) * 100).toFixed(2)}
                            onChange={(e) =>
                              updateProfile(
                                (d) =>
                                  void (d.holdings[i]!.expenseRatioPct = (Number(e.target.value) || 0) / 100),
                              )
                            }
                          />
                        </td>
                        <td className="right num">
                          {formatPercent(portfolio.totalValue > 0 ? value / portfolio.totalValue : 0, 1)}
                        </td>
                        <td>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => updateProfile((d) => void d.holdings.splice(i, 1))}
                            aria-label={`Remove ${h.name}`}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td colSpan={3} className="strong">
                      Cash and liquid savings
                    </td>
                    <td className="right" style={{ minWidth: 118 }}>
                      <MoneyInput
                        value={profile.liquidSavings}
                        currency={currency}
                        step={10000}
                        onChange={(v) => updateProfile((d) => void (d.liquidSavings = v))}
                      />
                    </td>
                    <td colSpan={3} className="text-xs text-subtle">
                      Counted as a cash allocation and used for your emergency-fund cover
                    </td>
                    <td className="right num">
                      {formatPercent(
                        portfolio.totalValue > 0 ? profile.liquidSavings / portfolio.totalValue : 0,
                        1,
                      )}
                    </td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}

      {/* Liabilities and payoff strategies. */}
      <Card
        title="Debts"
        subtitle={
          totalDebt > 0
            ? `${formatCompact(totalDebt, currency)} outstanding · ${formatCompact(snapshot.cashflow.totalEmi, currency)} of EMIs a month`
            : 'Nothing owed'
        }
        actions={
          <button
            className="btn btn-sm"
            onClick={() =>
              updateProfile((d) =>
                d.liabilities.push({
                  id: `l-${Date.now()}`,
                  name: 'New debt',
                  kind: 'personal_loan',
                  outstanding: 0,
                  interestRatePct: 0.12,
                  emi: 0,
                }),
              )
            }
          >
            + Add debt
          </button>
        }
      >
        {profile.liabilities.length === 0 ? (
          <Empty title="Debt free" message="Nothing owed — that is a strong place to be planning from." />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th className="right">Outstanding</th>
                    <th className="right">Rate</th>
                    <th className="right">EMI</th>
                    <th>Versus investing</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {profile.liabilities.map((l, i) => {
                    const beatsPortfolio = l.interestRatePct > portfolio.expectedReturnPct;
                    return (
                      <tr key={l.id}>
                        <td>
                          <input
                            className="input"
                            style={{ minWidth: 126 }}
                            value={l.name}
                            aria-label="Debt name"
                            onChange={(e) =>
                              updateProfile((d) => void (d.liabilities[i]!.name = e.target.value))
                            }
                          />
                        </td>
                        <td>
                          <select
                            className="select"
                            style={{ minWidth: 126 }}
                            value={l.kind}
                            aria-label="Debt type"
                            onChange={(e) =>
                              updateProfile(
                                (d) =>
                                  void (d.liabilities[i]!.kind = e.target
                                    .value as (typeof l)['kind']),
                              )
                            }
                          >
                            <option value="credit_card">Credit card</option>
                            <option value="personal_loan">Personal loan</option>
                            <option value="home_loan">Home loan</option>
                            <option value="car_loan">Car loan</option>
                            <option value="education_loan">Education loan</option>
                            <option value="other">Other</option>
                          </select>
                        </td>
                        <td className="right" style={{ minWidth: 118 }}>
                          <MoneyInput
                            value={l.outstanding}
                            currency={currency}
                            step={10000}
                            onChange={(v) => updateProfile((d) => void (d.liabilities[i]!.outstanding = v))}
                          />
                        </td>
                        <td className="right">
                          <input
                            className="input num"
                            type="number"
                            style={{ width: 78 }}
                            min={0}
                            max={100}
                            step={0.25}
                            aria-label="Interest rate percent"
                            value={(l.interestRatePct * 100).toFixed(2)}
                            onChange={(e) =>
                              updateProfile(
                                (d) =>
                                  void (d.liabilities[i]!.interestRatePct =
                                    (Number(e.target.value) || 0) / 100),
                              )
                            }
                          />
                        </td>
                        <td className="right" style={{ minWidth: 108 }}>
                          <MoneyInput
                            value={l.emi}
                            currency={currency}
                            step={1000}
                            onChange={(v) => updateProfile((d) => void (d.liabilities[i]!.emi = v))}
                          />
                        </td>
                        <td>
                          <Badge tone={beatsPortfolio ? 'negative' : 'info'}>
                            {beatsPortfolio ? 'clear this first' : 'cheap debt'}
                          </Badge>
                        </td>
                        <td>
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => updateProfile((d) => void d.liabilities.splice(i, 1))}
                            aria-label={`Remove ${l.name}`}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {debtPlans && (
              <>
                <div className="divider" style={{ margin: '16px 0' }} />
                <div className="card-title" style={{ marginBottom: 4 }}>
                  Payoff strategies
                </div>
                <div className="card-sub" style={{ marginBottom: 14 }}>
                  Avalanche clears the highest rate first and is mathematically optimal. Snowball
                  clears the smallest balance first and is easier to stick to. Both are shown because
                  the one you will actually follow is the better one.
                </div>

                {/* A balance that grows outranks any payoff-strategy comparison. */}
                {debtPlans.avalanche.unpayable.map((u) => (
                  <div key={u.liabilityId} style={{ marginBottom: 12 }}>
                    <Callout tone="negative">
                      <strong>{u.name}</strong> never clears at your current payment. At{' '}
                      {formatPercent(u.interestRatePct)} a year it accrues more interest each month
                      than you pay, so the balance grows by about{' '}
                      <strong>{formatCompact(u.monthlyShortfall, currency)}</strong> a month. Raising
                      that payment comes before every other step below.
                    </Callout>
                  </div>
                ))}

                <Slider
                  label="Extra you could put towards debt each month"
                  value={extraDebtPayment}
                  min={0}
                  max={Math.max(20000, Math.round(snapshot.cashflow.monthlyIncome * 0.3))}
                  step={1000}
                  onChange={setExtraDebtPayment}
                  format={(v) => (v ? `+${formatCompact(v, currency)}` : 'EMIs only')}
                />

                <div className="grid grid-2" style={{ marginTop: 14 }}>
                  {(['avalanche', 'snowball'] as const).map((strategy) => {
                    const plan = debtPlans[strategy];
                    const other = debtPlans[strategy === 'avalanche' ? 'snowball' : 'avalanche'];
                    const better = plan.totalInterestPaid <= other.totalInterestPaid;
                    return (
                      <div className="card" key={strategy} style={{ background: 'var(--surface-sunken)' }}>
                        <div className="row-between" style={{ marginBottom: 11 }}>
                          <span className="card-title" style={{ textTransform: 'capitalize' }}>
                            {strategy}
                          </span>
                          {better && <Badge tone="positive">costs less</Badge>}
                        </div>
                        <div className="grid grid-2" style={{ gap: 12 }}>
                          <Stat
                            label={plan.clearsEverything ? 'Debt free in' : 'Clears what it can in'}
                            value={`${plan.monthsToDebtFree} mo`}
                            meta={
                              plan.clearsEverything
                                ? `${(plan.monthsToDebtFree / 12).toFixed(1)} years`
                                : `${plan.order.length} of ${profile.liabilities.length} debts`
                            }
                            tone={plan.clearsEverything ? 'neutral' : 'warning'}
                          />
                          <Stat
                            label="Total interest"
                            value={formatCompact(plan.totalInterestPaid, currency)}
                            tone={better ? 'positive' : 'negative'}
                          />
                        </div>
                        <div className="divider" style={{ margin: '12px 0' }} />
                        <div className="stack-sm">
                          {plan.order.map((o, idx) => (
                            <div className="row-between text-sm" key={o.liabilityId}>
                              <span className="text-muted">
                                {idx + 1}. {o.name}
                              </span>
                              <span className="num text-xs text-subtle">month {o.payoffMonth}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <Callout tone="info">
                  Avalanche saves{' '}
                  <strong>
                    {formatCompact(
                      Math.abs(debtPlans.snowball.totalInterestPaid - debtPlans.avalanche.totalInterestPaid),
                      currency,
                    )}
                  </strong>{' '}
                  in interest over snowball here. If the gap is small, pick the one you will stick to —
                  a plan abandoned halfway costs more than either.
                </Callout>
              </>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
