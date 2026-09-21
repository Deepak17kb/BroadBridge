import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  formatCompact,
  formatPercent,
  RISK_QUESTIONS,
  scoreRisk,
  type UserProfile,
} from '@wealth/shared';
import { api } from '../lib/api';
import { useLoadedProfile, useProfile } from '../state/ProfileContext';
import {
  Badge,
  Callout,
  Card,
  Icon,
  MoneyInput,
  NumberInput,
  ProgressBar,
  ScoreRing,
  Stat,
} from '../components/ui';
import { ExpenseBars } from '../components/charts/Charts';

/**
 * Profile editor.
 *
 * Every field here feeds the engine directly, and because the snapshot is
 * recomputed locally on each change, the live summary beside the form moves as
 * the user types. Editing the risk questionnaire re-scores the profile
 * immediately, which is the clearest way to show that the recommendation is a
 * consequence of the answers rather than a fixed label.
 */
export function Profile() {
  const { profile, snapshot } = useLoadedProfile();
  const { updateProfile, reset } = useProfile();
  const navigate = useNavigate();
  const { currency } = profile;

  const [newCategory, setNewCategory] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Scored from the live draft so the panel updates on every answer.
  const risk = scoreRisk(profile);

  return (
    <div className="stack">
      <header className="page-head">
        <h1>My Details</h1>
        <p>
          Everything the plan is built from. Change any number and the dashboard, every projection
          and the assistant's next answer all update — there is no separate copy of your data.
        </p>
      </header>

      <div className="grid grid-sidebar">
        <div className="stack">
          <Card title="About you">
            <div className="grid grid-3">
              <div className="field">
                <label htmlFor="p-name">Name</label>
                <input
                  id="p-name"
                  className="input"
                  value={profile.displayName}
                  onChange={(e) => updateProfile((d) => void (d.displayName = e.target.value))}
                />
              </div>
              <div className="field">
                <label htmlFor="p-age">Age</label>
                {/*
                  Committed only when it is a whole age below the retirement
                  age. Each keystroke used to save: typing 45 stored an age of
                  4 on the way, and an age at or past retirement - which the
                  retirement field below already refused - went through here,
                  gave every projection a negative horizon, and made the server
                  reject every save after it.
                */}
                <NumberInput
                  id="p-age"
                  className="input num"
                  min={16}
                  max={100}
                  value={profile.age}
                  onChange={(next) =>
                    updateProfile((d) => {
                      if (Number.isInteger(next) && next >= 16 && next < d.retirementAge) d.age = next;
                    })
                  }
                />
                <div className="field-hint">Must be below your retirement age</div>
              </div>
              <div className="field">
                <label htmlFor="p-retire">Retirement age</label>
                <NumberInput
                  id="p-retire"
                  className="input num"
                  min={profile.age + 1}
                  max={100}
                  value={profile.retirementAge}
                  onChange={(next) =>
                    updateProfile((d) => {
                      // Guarded here as well as server-side: an inverted pair
                      // would produce a negative horizon everywhere downstream.
                      // The field keeps the partial text, so typing "6" on the
                      // way to 62 no longer snaps back to the old value.
                      if (Number.isInteger(next) && next > d.age && next >= 30 && next <= 100) {
                        d.retirementAge = next;
                      }
                    })
                  }
                />
                <div className="field-hint">
                  {snapshot.retirement.yearsToRetirement} years of earning left
                </div>
              </div>
              <div className="field">
                <label htmlFor="p-dependents">Dependents</label>
                <NumberInput
                  id="p-dependents"
                  className="input num"
                  min={0}
                  max={12}
                  value={profile.dependents}
                  onChange={(next) =>
                    updateProfile((d) => void (d.dependents = Math.min(12, Math.max(0, Math.round(next)))))
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="p-stability">Income stability</label>
                <select
                  id="p-stability"
                  className="select"
                  value={profile.incomeStability}
                  onChange={(e) =>
                    updateProfile(
                      (d) => void (d.incomeStability = e.target.value as UserProfile['incomeStability']),
                    )
                  }
                >
                  <option value="stable">Stable</option>
                  <option value="variable">Variable</option>
                  <option value="uncertain">Uncertain</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="p-growth">Annual pay rise (%)</label>
                <NumberInput
                  id="p-growth"
                  className="input num"
                  min={0}
                  max={50}
                  value={Math.round(profile.cashflow.annualIncomeGrowthPct * 10000) / 100}
                  onChange={(next) =>
                    updateProfile(
                      (d) => void (d.cashflow.annualIncomeGrowthPct = Math.min(50, Math.max(0, next)) / 100),
                    )
                  }
                />
              </div>
            </div>
          </Card>

          <Card title="Income">
            <div className="grid grid-3">
              <MoneyInput
                label="Monthly take-home"
                value={profile.cashflow.monthlyNetIncome}
                currency={currency}
                step={5000}
                onChange={(v) => updateProfile((d) => void (d.cashflow.monthlyNetIncome = v))}
              />
              <MoneyInput
                label="Other monthly income"
                value={profile.cashflow.otherMonthlyIncome}
                currency={currency}
                step={2000}
                onChange={(v) => updateProfile((d) => void (d.cashflow.otherMonthlyIncome = v))}
              />
              <MoneyInput
                label="Cash and liquid savings"
                value={profile.liquidSavings}
                currency={currency}
                step={10000}
                onChange={(v) => updateProfile((d) => void (d.liquidSavings = v))}
                hint="Sets your emergency-fund cover"
              />
            </div>
          </Card>

          <Card
            title="Monthly spending"
            subtitle={`${formatCompact(snapshot.cashflow.monthlyExpenses, currency)} across ${Object.keys(profile.cashflow.monthlyExpenses).length} categories`}
          >
            <div className="expense-grid">
              {Object.entries(profile.cashflow.monthlyExpenses).map(([category, amount]) => (
                <div key={category}>
                  <MoneyInput
                    label={category}
                    value={amount}
                    currency={currency}
                    step={500}
                    onChange={(v) => updateProfile((d) => void (d.cashflow.monthlyExpenses[category] = v))}
                  />
                  <button
                    className="btn btn-sm btn-ghost mt-1"
                    onClick={() =>
                      updateProfile((d) => {
                        delete d.cashflow.monthlyExpenses[category];
                      })
                    }
                    aria-label={`Remove ${category}`}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>

            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                const name = newCategory.trim();
                if (!name) return;
                updateProfile((d) => void (d.cashflow.monthlyExpenses[name] = 0));
                setNewCategory('');
              }}
            >
              <input
                className="input input-short"
                placeholder="New category name"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                aria-label="New expense category"
              />
              <button className="btn btn-sm" type="submit" disabled={!newCategory.trim()}>
                <Icon name="plus" /> Add category
              </button>
            </form>

            <hr className="divider" />
            <ExpenseBars breakdown={snapshot.cashflow.expenseBreakdown} currency={currency} />
          </Card>

          <Card title="Protection" subtitle="Insurance protects the plan; it is not part of its return">
            <div className="grid grid-2">
              <MoneyInput
                label="Life insurance cover"
                value={profile.lifeInsuranceCover ?? 0}
                currency={currency}
                step={500000}
                onChange={(v) => updateProfile((d) => void (d.lifeInsuranceCover = v))}
                hint={`A 10x income rule implies ${formatCompact(snapshot.cashflow.monthlyIncome * 120, currency)}`}
              />
              <MoneyInput
                label="Health insurance cover"
                value={profile.healthInsuranceCover ?? 0}
                currency={currency}
                step={100000}
                onChange={(v) => updateProfile((d) => void (d.healthInsuranceCover = v))}
              />
            </div>
            {profile.dependents > 0 &&
              (profile.lifeInsuranceCover ?? 0) < snapshot.cashflow.monthlyIncome * 120 * 0.8 && (
                <Callout tone="warning">
                  With {profile.dependents} dependent
                  {profile.dependents === 1 ? '' : 's'}, your cover is below the 10x income rule. A pure
                  term policy costs a fraction of a savings-linked one for the same protection.
                </Callout>
              )}
          </Card>

          <Card
            title="Risk questionnaire"
            subtitle="Re-answer any question and your profile re-scores immediately"
          >
            <div className="stack">
              {RISK_QUESTIONS.map((q) => (
                <div key={q.id}>
                  <div className="row-between items-start mb-2">
                    <span className="field-label" id={`risk-q-${q.id}`}>
                      {q.prompt}
                    </span>
                    <Badge>{q.dimension === 'tolerance' ? 'willingness' : 'ability'}</Badge>
                  </div>
                  <div className="stack-sm" role="radiogroup" aria-labelledby={`risk-q-${q.id}`}>
                    {q.options.map((opt, idx) => {
                      const checked = profile.riskAnswers[q.id] === idx;
                      return (
                        <label key={opt} className={`checkbox ${checked ? 'checked' : ''}`}>
                          <input
                            type="radio"
                            name={`risk-${q.id}`}
                            checked={checked}
                            onChange={() => updateProfile((d) => void (d.riskAnswers[q.id] = idx))}
                          />
                          <span className="text-sm">{opt}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Data and privacy">
            <div className="stack-sm">
              <Callout tone="info">
                This profile holds synthetic demonstration data. Nothing here is connected to a real
                account, and no real financial institution is integrated.
              </Callout>
              <div className="row-wrap">
                <button className="btn" onClick={reset}>
                  Switch profile
                </button>
                {confirmingDelete ? (
                  <>
                    <button
                      className="btn btn-danger"
                      onClick={async () => {
                        await api.deleteProfile(profile.id).catch(() => undefined);
                        reset();
                        navigate('/');
                      }}
                    >
                      Yes, delete permanently
                    </button>
                    <button className="btn btn-ghost" onClick={() => setConfirmingDelete(false)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button className="btn btn-danger" onClick={() => setConfirmingDelete(true)}>
                    Delete this profile
                  </button>
                )}
              </div>
              {confirmingDelete && (
                <div className="text-xs text-negative">
                  This removes the profile and its conversation history. It cannot be undone.
                </div>
              )}
              <div className="text-xs text-subtle">
                Created {new Date(profile.createdAt).toLocaleDateString()} · last updated{' '}
                {new Date(profile.updatedAt).toLocaleString()}
              </div>
            </div>
          </Card>
        </div>

        {/* Live effect of the edits. */}
        <div className="stack sticky-aside">
          <Card title="Your risk profile">
            <div className="row gap-4">
              <ScoreRing score={risk.effectiveScore} size={104} />
              <div className="flex-1">
                <Badge tone="accent">{risk.bucket}</Badge>
                <div className="stack-sm mt-3">
                  <div>
                    <div className="row-between text-xs">
                      <span className="text-muted">Willingness</span>
                      <span className="num">{risk.toleranceScore}</span>
                    </div>
                    <ProgressBar value={risk.toleranceScore / 100} tone="positive" label="Willingness" />
                  </div>
                  <div>
                    <div className="row-between text-xs">
                      <span className="text-muted">Ability</span>
                      <span className="num">{risk.capacityScore}</span>
                    </div>
                    <ProgressBar value={risk.capacityScore / 100} tone="warning" label="Ability" />
                  </div>
                </div>
              </div>
            </div>
            <hr className="divider" />
            <ul className="bullets text-xs text-muted">
              {risk.drivers.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </Card>

          <Card title="Live plan summary">
            <div className="stack-sm">
              <Stat
                label="Wellness score"
                value={`${snapshot.wellness.total}/100`}
                meta={`Grade ${snapshot.wellness.grade}`}
              />
              <hr className="divider" />
              <div className="row-between text-sm">
                <span className="text-muted">Monthly surplus</span>
                <span className={`num strong ${snapshot.cashflow.monthlySurplus >= 0 ? 'text-positive' : 'text-negative'}`}>
                  {formatCompact(snapshot.cashflow.monthlySurplus, currency)}
                </span>
              </div>
              <div className="row-between text-sm">
                <span className="text-muted">Savings rate</span>
                <span className="num">{formatPercent(snapshot.cashflow.savingsRatePct, 0)}</span>
              </div>
              <div className="row-between text-sm">
                <span className="text-muted">Emergency cover</span>
                <span className="num">{snapshot.cashflow.emergencyFundMonths.toFixed(1)} months</span>
              </div>
              <div className="row-between text-sm">
                <span className="text-muted">Net worth</span>
                <span className="num">{formatCompact(snapshot.netWorth.netWorth, currency)}</span>
              </div>
              <div className="row-between text-sm">
                <span className="text-muted">Retirement funded</span>
                <span className="num">{formatPercent(snapshot.retirement.readinessRatio, 0)}</span>
              </div>
              <div className="row-between text-sm">
                <span className="text-muted">Goals on track</span>
                <span className="num">
                  {snapshot.goalProjections.filter((g) => g.onTrack).length} /{' '}
                  {snapshot.goalProjections.length}
                </span>
              </div>
              <div className="row-between text-sm">
                <span className="text-muted">Actions outstanding</span>
                <span className="num">{snapshot.actions.length}</span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
