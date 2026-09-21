import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  buildSnapshot,
  emptyProfile,
  formatCompact,
  RISK_QUESTIONS,
  scoreRisk,
  type Goal,
  type UserProfile,
} from '@wealth/shared';
import { api, type PersonaSummary } from '../lib/api';
import { useProfile } from '../state/ProfileContext';
import { Callout, MoneyInput, NumberInput, ScoreRing } from '../components/ui';

/**
 * Onboarding.
 *
 * Two routes in, because they serve different visitors: a sample profile for
 * someone evaluating the product in thirty seconds, and a five-step wizard for
 * someone entering their own position.
 *
 * The wizard computes its preview with the shared engine on every keystroke, so
 * the user watches their wellness score and surplus move as they type. That
 * feedback is the whole reason people finish a form this long - a progress bar
 * alone does not earn five steps of data entry.
 */

type Step = 0 | 1 | 2 | 3 | 4 | 5;

const STEP_TITLES = [
  'Get started',
  'About you',
  'Money in, money out',
  'What you own and owe',
  'Your goals',
  'Your appetite for risk',
] as const;

const DEFAULT_EXPENSES = ['Housing', 'Food', 'Transport', 'Utilities', 'Healthcare', 'Lifestyle', 'Other'];

/**
 * A stored fraction as the percentage its field shows. Two decimals rather than
 * whole numbers, so an 8.5% rate reads back as 8.5 instead of snapping to 9
 * while the plan quietly uses 8.5; the rounding only strips float noise
 * (0.07 * 100 is 7.000000000000001).
 */
function asPercent(fraction: number): number {
  return Math.round(fraction * 10000) / 100;
}

const MIN_AGE = 16;
const MAX_AGE = 100;

/**
 * Whether the two ages are entered and sensible, and what to say if not.
 *
 * The wizard starts both at 0, meaning "not entered yet" - they are the user's
 * to state, and pre-filling 30 and 60 put numbers in the plan nobody chose. An
 * empty field is unfinished rather than wrong, so it holds Continue back
 * without a warning: nobody should open a form and find it already in red.
 */
export function checkAges(d: Pick<UserProfile, 'age' | 'retirementAge'>): {
  ready: boolean;
  problems: string[];
} {
  const problems: string[] = [];
  if (d.age !== 0 && (d.age < MIN_AGE || d.age > MAX_AGE)) {
    problems.push(`Enter an age between ${MIN_AGE} and ${MAX_AGE}.`);
  }
  if (d.age !== 0 && d.retirementAge !== 0) {
    if (d.retirementAge <= d.age) {
      problems.push('Retirement age needs to be higher than your current age.');
    } else if (d.retirementAge > MAX_AGE) {
      problems.push(`Retirement age can be at most ${MAX_AGE}.`);
    }
  }
  return { ready: d.age !== 0 && d.retirementAge !== 0 && problems.length === 0, problems };
}

export function Onboarding() {
  const navigate = useNavigate();
  const { setProfile, createFromPersona, theme, toggleTheme } = useProfile();
  const [step, setStep] = useState<Step>(0);
  const [personas, setPersonas] = useState<PersonaSummary[]>([]);
  const [selectedPersona, setSelectedPersona] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [draft, setDraft] = useState<UserProfile>(() => {
    const base = emptyProfile('draft', '');
    base.cashflow.monthlyExpenses = Object.fromEntries(DEFAULT_EXPENSES.map((c) => [c, 0]));
    // Blank, not 30 and 60: see `checkAges`. `emptyProfile` keeps its defaults,
    // because the server's blank-profile path needs a profile that projects.
    base.age = 0;
    base.retirementAge = 0;
    return base;
  });

  useEffect(() => {
    api.personas().then(setPersonas).catch(() => setPersonas([]));
  }, []);

  const update = (mutate: (d: UserProfile) => void) =>
    setDraft((current) => {
      const next = structuredClone(current);
      mutate(next);
      return next;
    });

  // Live preview. Cheap enough to recompute on every change - it is arithmetic
  // over a small object, not a network call.
  const ages = checkAges(draft);

  const preview = useMemo(() => {
    const hasIncome = draft.cashflow.monthlyNetIncome > 0;
    // Someone who goes back and clears their age would otherwise see a score
    // worked out for a 0-year-old.
    if (!hasIncome || !checkAges(draft).ready) return null;
    try {
      return buildSnapshot(draft);
    } catch {
      // A half-filled draft can be internally inconsistent; the preview simply
      // waits rather than breaking the form.
      return null;
    }
  }, [draft]);

  const risk = useMemo(() => {
    try {
      return scoreRisk(draft);
    } catch {
      return null;
    }
  }, [draft]);

  async function startFromPersona(personaId: string) {
    setBusy(true);
    setError(null);
    try {
      await createFromPersona(personaId);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load that sample profile');
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createProfile({ displayName: draft.displayName || 'You' });
      // The blank profile is created server-side to get a stable id, then the
      // wizard's contents are saved over it in one write.
      const saved = await api.saveProfile({
        ...draft,
        id: created.profile.id,
        displayName: draft.displayName || 'You',
        createdAt: created.profile.createdAt,
        updatedAt: new Date().toISOString(),
      });
      setProfile(saved.profile);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your details');
    } finally {
      setBusy(false);
    }
  }

  const canAdvance = (): boolean => {
    switch (step) {
      case 1:
        return draft.displayName.trim().length > 0 && ages.ready;
      case 2:
        return draft.cashflow.monthlyNetIncome > 0;
      default:
        return true;
    }
  };

  return (
    <div className="onboarding">
      <div className="onboarding-card">
        <header className="onboarding-head">
          <div className="row-between">
            <div className="row" style={{ gap: 12 }}>
              <div className="brand-mark" aria-hidden="true">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 17l6-7 4 4 8-9" />
                </svg>
              </div>
              <div>
                <h1 style={{ fontSize: '1.28rem' }}>AI Wealth Navigator</h1>
                <div className="text-sm text-muted">{STEP_TITLES[step]}</div>
              </div>
            </div>
            <button className="btn btn-icon btn-ghost" onClick={toggleTheme} aria-label="Toggle theme">
              {theme === 'dark' ? '☀' : '☾'}
            </button>
          </div>
          {step > 0 && (
            <div className="steps" aria-label={`Step ${step} of 5`}>
              {[1, 2, 3, 4, 5].map((n) => (
                <div key={n} className={`step-pip ${n < step ? 'done' : n === step ? 'active' : ''}`}>
                  <div className="bar-fill" style={{ width: n <= step ? '100%' : '0%' }} />
                </div>
              ))}
            </div>
          )}
        </header>

        <div className="onboarding-body">
          {error && <Callout tone="negative">{error}</Callout>}

          {step === 0 && (
            <div className="stack">
              <p className="text-muted" style={{ maxWidth: '62ch' }}>
                Understand where you stand, test what-if scenarios against thousands of simulated
                markets, and get next steps that show their own arithmetic. Every projection tells
                you what it assumed.
              </p>

              <div>
                <div className="stat-label" style={{ marginBottom: 9 }}>
                  Explore a sample profile
                </div>
                <div className="persona-grid">
                  {personas.map((p) => (
                    <button
                      key={p.id}
                      className={`persona ${selectedPersona === p.id ? 'selected' : ''}`}
                      onClick={() => setSelectedPersona(p.id)}
                      disabled={busy}
                    >
                      <div className="strong text-sm">{p.label}</div>
                      <div className="text-xs text-muted" style={{ marginTop: 3 }}>
                        {p.tagline}
                      </div>
                      <div className="text-xs text-subtle" style={{ marginTop: 8, lineHeight: 1.45 }}>
                        {p.challenge}
                      </div>
                    </button>
                  ))}
                  {personas.length === 0 && (
                    <div className="text-sm text-subtle">Loading sample profiles…</div>
                  )}
                </div>
              </div>

              <div className="row-wrap" style={{ gap: 10 }}>
                <button
                  className="btn btn-primary"
                  disabled={!selectedPersona || busy}
                  onClick={() => selectedPersona && startFromPersona(selectedPersona)}
                >
                  {busy ? 'Loading…' : 'Open this sample profile'}
                </button>
                <span className="text-sm text-subtle">or</span>
                <button className="btn" onClick={() => setStep(1)} disabled={busy}>
                  Enter my own numbers
                </button>
              </div>

              <Callout tone="info">
                All sample data is synthetic and fabricated for this project. Nothing here is real
                market data, and nothing here is financial advice.
              </Callout>
            </div>
          )}

          {step === 1 && (
            <div className="stack">
              <div className="grid grid-2">
                <div className="field">
                  <label htmlFor="ob-name">What should we call you?</label>
                  <input
                    id="ob-name"
                    className="input"
                    value={draft.displayName}
                    placeholder="Your name"
                    autoFocus
                    onChange={(e) => update((d) => void (d.displayName = e.target.value))}
                  />
                </div>
                <div className="field">
                  <label htmlFor="ob-age">Your age</label>
                  <NumberInput
                    id="ob-age"
                    className="input num"
                    placeholder=""
                    min={MIN_AGE}
                    max={MAX_AGE}
                    value={draft.age}
                    onChange={(v) => update((d) => void (d.age = v))}
                  />
                </div>
                <div className="field">
                  <label htmlFor="ob-retire">Target retirement age</label>
                  <NumberInput
                    id="ob-retire"
                    className="input num"
                    placeholder=""
                    min={draft.age + 1}
                    max={MAX_AGE}
                    value={draft.retirementAge}
                    onChange={(v) => update((d) => void (d.retirementAge = v))}
                  />
                  {ages.ready && (
                    <div className="field-hint">
                      {draft.retirementAge - draft.age} years of earning left to plan with
                    </div>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="ob-dependents">People financially dependent on you</label>
                  <NumberInput
                    id="ob-dependents"
                    className="input num"
                    min={0}
                    max={12}
                    value={draft.dependents}
                    onChange={(v) => update((d) => void (d.dependents = v))}
                  />
                </div>
                <div className="field">
                  <label htmlFor="ob-stability">How predictable is your income?</label>
                  <select
                    id="ob-stability"
                    className="select"
                    value={draft.incomeStability}
                    onChange={(e) =>
                      update((d) => void (d.incomeStability = e.target.value as UserProfile['incomeStability']))
                    }
                  >
                    <option value="stable">Stable - salaried, secure</option>
                    <option value="variable">Variable - commission, freelance, business</option>
                    <option value="uncertain">Uncertain - between roles or just starting</option>
                  </select>
                  <div className="field-hint">This caps how much investment risk the plan will suggest.</div>
                </div>
              </div>
              {ages.problems.map((problem) => (
                <Callout key={problem} tone="warning">
                  {problem}
                </Callout>
              ))}
            </div>
          )}

          {step === 2 && (
            <div className="stack">
              <div className="grid grid-3">
                <MoneyInput
                  id="ob-income"
                  label="Monthly take-home pay"
                  value={draft.cashflow.monthlyNetIncome}
                  currency={draft.currency}
                  onChange={(v) => update((d) => void (d.cashflow.monthlyNetIncome = v))}
                  hint="After tax and deductions"
                />
                <MoneyInput
                  label="Other monthly income"
                  value={draft.cashflow.otherMonthlyIncome}
                  currency={draft.currency}
                  onChange={(v) => update((d) => void (d.cashflow.otherMonthlyIncome = v))}
                  hint="Rent, freelance, dividends"
                />
                <div className="field">
                  <label htmlFor="ob-growth">Expected annual pay rise</label>
                  <div className="input-prefix">
                    <NumberInput
                      id="ob-growth"
                      className="input num"
                      min={0}
                      max={50}
                      step={1}
                      style={{ paddingLeft: 11 }}
                      value={asPercent(draft.cashflow.annualIncomeGrowthPct)}
                      onChange={(v) => update((d) => void (d.cashflow.annualIncomeGrowthPct = v / 100))}
                    />
                  </div>
                  <div className="field-hint">Percent per year. Drives the step-up recommendation.</div>
                </div>
              </div>

              <div>
                <div className="stat-label" style={{ marginBottom: 9 }}>
                  Monthly spending by category
                </div>
                <div className="expense-grid">
                  {Object.entries(draft.cashflow.monthlyExpenses).map(([category, amount]) => (
                    <MoneyInput
                      key={category}
                      label={category}
                      value={amount}
                      currency={draft.currency}
                      step={500}
                      onChange={(v) => update((d) => void (d.cashflow.monthlyExpenses[category] = v))}
                    />
                  ))}
                </div>
              </div>

              <MoneyInput
                label="Cash and savings you can reach within a day"
                value={draft.liquidSavings}
                currency={draft.currency}
                onChange={(v) => update((d) => void (d.liquidSavings = v))}
                hint="Bank balances, liquid funds, sweep deposits. This sets your emergency-fund cover."
              />

              {preview && (
                <Callout tone={preview.cashflow.monthlySurplus >= 0 ? 'positive' : 'warning'}>
                  You are {preview.cashflow.monthlySurplus >= 0 ? 'left with' : 'short by'}{' '}
                  <strong>{formatCompact(Math.abs(preview.cashflow.monthlySurplus), draft.currency)}</strong> a
                  month, a savings rate of{' '}
                  <strong>{(preview.cashflow.savingsRatePct * 100).toFixed(0)}%</strong>. Your cash covers{' '}
                  <strong>{preview.cashflow.emergencyFundMonths.toFixed(1)} months</strong> of expenses.
                </Callout>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="stack">
              <p className="text-sm text-muted">
                Add what you hold and what you owe. You can skip this and add it later - the plan just
                gets more accurate with it.
              </p>

              <div className="grid grid-2">
                <MoneyInput
                  label="Life insurance cover"
                  value={draft.lifeInsuranceCover ?? 0}
                  currency={draft.currency}
                  step={100000}
                  onChange={(v) => update((d) => void (d.lifeInsuranceCover = v))}
                  hint="Total sum assured across policies"
                />
                <MoneyInput
                  label="Health insurance cover"
                  value={draft.healthInsuranceCover ?? 0}
                  currency={draft.currency}
                  step={100000}
                  onChange={(v) => update((d) => void (d.healthInsuranceCover = v))}
                />
              </div>

              <div className="divider" />

              <div className="row-between">
                <div className="stat-label">Investments</div>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    update((d) =>
                      d.holdings.push({
                        id: `h-${Date.now()}`,
                        symbol: 'FUND',
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
              </div>
              {draft.holdings.length === 0 && (
                <div className="text-sm text-subtle">No investments added yet.</div>
              )}
              {draft.holdings.map((h, i) => (
                <div className="row-wrap" key={h.id} style={{ gap: 8 }}>
                  <input
                    className="input"
                    style={{ flex: '2 1 150px' }}
                    value={h.name}
                    aria-label="Holding name"
                    onChange={(e) => update((d) => void (d.holdings[i]!.name = e.target.value))}
                  />
                  <select
                    className="select"
                    style={{ flex: '1 1 130px' }}
                    value={h.assetClass}
                    aria-label="Asset class"
                    onChange={(e) =>
                      update((d) => void (d.holdings[i]!.assetClass = e.target.value as typeof h.assetClass))
                    }
                  >
                    <option value="equity_domestic">Domestic equity</option>
                    <option value="equity_international">International equity</option>
                    <option value="debt">Debt / bonds</option>
                    <option value="gold">Gold</option>
                    <option value="reit">REITs</option>
                    <option value="cash">Cash</option>
                  </select>
                  <select
                    className="select"
                    style={{ flex: '0 1 112px' }}
                    value={h.instrumentKind ?? 'fund'}
                    aria-label="Instrument type"
                    onChange={(e) =>
                      update((d) => void (d.holdings[i]!.instrumentKind = e.target.value as 'fund' | 'security' | 'deposit'))
                    }
                  >
                    <option value="fund">Fund</option>
                    <option value="security">Single stock</option>
                    <option value="deposit">Deposit</option>
                  </select>
                  <div style={{ flex: '1 1 118px' }}>
                    <MoneyInput
                      value={h.units * h.price}
                      currency={draft.currency}
                      step={10000}
                      onChange={(v) =>
                        update((d) => {
                          // Value is the natural thing to type; units stay at 1
                          // so price carries the amount.
                          d.holdings[i]!.units = 1;
                          d.holdings[i]!.price = v;
                          if (d.holdings[i]!.costBasis === 0) d.holdings[i]!.costBasis = v;
                        })
                      }
                    />
                  </div>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => update((d) => void d.holdings.splice(i, 1))}
                    aria-label={`Remove ${h.name}`}
                  >
                    Remove
                  </button>
                </div>
              ))}

              <div className="divider" />

              <div className="row-between">
                <div className="stat-label">Loans and debts</div>
                <button
                  className="btn btn-sm"
                  onClick={() =>
                    update((d) =>
                      d.liabilities.push({
                        id: `l-${Date.now()}`,
                        name: 'New loan',
                        kind: 'personal_loan',
                        outstanding: 0,
                        interestRatePct: 0.1,
                        emi: 0,
                      }),
                    )
                  }
                >
                  + Add debt
                </button>
              </div>
              {draft.liabilities.length === 0 && (
                <div className="text-sm text-subtle">No debts added - good place to be.</div>
              )}
              {draft.liabilities.map((l, i) => (
                <div className="row-wrap" key={l.id} style={{ gap: 8 }}>
                  <input
                    className="input"
                    style={{ flex: '2 1 140px' }}
                    value={l.name}
                    aria-label="Debt name"
                    onChange={(e) => update((d) => void (d.liabilities[i]!.name = e.target.value))}
                  />
                  <select
                    className="select"
                    style={{ flex: '1 1 130px' }}
                    value={l.kind}
                    aria-label="Debt type"
                    onChange={(e) => update((d) => void (d.liabilities[i]!.kind = e.target.value as typeof l.kind))}
                  >
                    <option value="credit_card">Credit card</option>
                    <option value="personal_loan">Personal loan</option>
                    <option value="home_loan">Home loan</option>
                    <option value="car_loan">Car loan</option>
                    <option value="education_loan">Education loan</option>
                    <option value="other">Other</option>
                  </select>
                  <div style={{ flex: '1 1 118px' }}>
                    <MoneyInput
                      value={l.outstanding}
                      currency={draft.currency}
                      step={10000}
                      onChange={(v) => update((d) => void (d.liabilities[i]!.outstanding = v))}
                    />
                  </div>
                  <div style={{ flex: '0 1 88px' }} className="field">
                    <NumberInput
                      className="input num"
                      min={0}
                      max={100}
                      step={0.5}
                      aria-label="Interest rate percent"
                      value={asPercent(l.interestRatePct)}
                      onChange={(v) => update((d) => void (d.liabilities[i]!.interestRatePct = v / 100))}
                    />
                    <div className="field-hint">% APR</div>
                  </div>
                  <div style={{ flex: '1 1 104px' }}>
                    <MoneyInput
                      value={l.emi}
                      currency={draft.currency}
                      step={1000}
                      onChange={(v) => update((d) => void (d.liabilities[i]!.emi = v))}
                    />
                  </div>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => update((d) => void d.liabilities.splice(i, 1))}
                    aria-label={`Remove ${l.name}`}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {step === 4 && (
            <div className="stack">
              <div className="row-between">
                <p className="text-sm text-muted" style={{ margin: 0, maxWidth: '54ch' }}>
                  Name what you are actually saving for. Goals with names get funded; "investing in
                  general" does not.
                </p>
                <button className="btn btn-sm" onClick={() => update((d) => d.goals.push(newGoal()))}>
                  + Add goal
                </button>
              </div>

              {draft.goals.length === 0 && (
                <div className="stack-sm">
                  <div className="text-sm text-subtle">No goals yet. Common starting points:</div>
                  <div className="row-wrap">
                    {SUGGESTED_GOALS.map((s) => (
                      <button
                        key={s.name}
                        className="suggestion"
                        onClick={() =>
                          update((d) =>
                            d.goals.push({
                              ...newGoal(),
                              name: s.name,
                              kind: s.kind,
                              targetYear: new Date().getUTCFullYear() + s.years,
                              targetAmountToday: s.multiple
                                ? Math.round(
                                    Object.values(d.cashflow.monthlyExpenses).reduce((a, b) => a + b, 0) *
                                      s.multiple,
                                  )
                                : s.amount ?? 0,
                              priority: s.priority,
                              ...(s.inflation ? { inflationOverridePct: s.inflation } : {}),
                            }),
                          )
                        }
                      >
                        + {s.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {draft.goals.map((g, i) => (
                <div className="card" key={g.id} style={{ padding: 14 }}>
                  <div className="row-between" style={{ marginBottom: 10 }}>
                    <input
                      className="input"
                      style={{ maxWidth: 260, fontWeight: 600 }}
                      value={g.name}
                      aria-label="Goal name"
                      onChange={(e) => update((d) => void (d.goals[i]!.name = e.target.value))}
                    />
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() => update((d) => void d.goals.splice(i, 1))}
                    >
                      Remove
                    </button>
                  </div>
                  <div className="grid grid-3">
                    <MoneyInput
                      label="Cost in today's money"
                      value={g.targetAmountToday}
                      currency={draft.currency}
                      step={50000}
                      onChange={(v) => update((d) => void (d.goals[i]!.targetAmountToday = v))}
                      hint="The engine inflates this to the target year"
                    />
                    <div className="field">
                      <label htmlFor={`goal-year-${g.id}`}>Target year</label>
                      {/* Only a whole year in range reaches the draft: typing
                          2031 used to store 2, 20 and 203 on the way, and a
                          year left in the past failed the final save with a
                          bare "Request body failed validation". */}
                      <NumberInput
                        id={`goal-year-${g.id}`}
                        className="input num"
                        min={new Date().getUTCFullYear()}
                        max={2120}
                        value={g.targetYear}
                        onChange={(v) => {
                          const thisYear = new Date().getUTCFullYear();
                          if (Number.isInteger(v) && v >= thisYear && v <= 2120) {
                            update((d) => void (d.goals[i]!.targetYear = v));
                          }
                        }}
                      />
                    </div>
                    <MoneyInput
                      label="Already saved for it"
                      value={g.currentSaved}
                      currency={draft.currency}
                      step={10000}
                      onChange={(v) => update((d) => void (d.goals[i]!.currentSaved = v))}
                    />
                    <MoneyInput
                      label="Saving each month"
                      value={g.monthlyContribution}
                      currency={draft.currency}
                      step={1000}
                      onChange={(v) => update((d) => void (d.goals[i]!.monthlyContribution = v))}
                    />
                    <div className="field">
                      <label htmlFor={`goal-stepup-${g.id}`}>Annual step-up</label>
                      <NumberInput
                        id={`goal-stepup-${g.id}`}
                        className="input num"
                        min={0}
                        max={50}
                        value={asPercent(g.contributionStepUpPct)}
                        onChange={(v) => update((d) => void (d.goals[i]!.contributionStepUpPct = v / 100))}
                      />
                      <div className="field-hint">% increase each year</div>
                    </div>
                    <div className="field">
                      <label htmlFor={`goal-priority-${g.id}`}>Priority</label>
                      <select
                        id={`goal-priority-${g.id}`}
                        className="select"
                        value={g.priority}
                        onChange={(e) => update((d) => void (d.goals[i]!.priority = e.target.value as Goal['priority']))}
                      >
                        <option value="must_have">Must have</option>
                        <option value="important">Important</option>
                        <option value="aspirational">Nice to have</option>
                      </select>
                    </div>
                  </div>
                  {preview?.goalProjections
                    .filter((p) => p.goalId === g.id)
                    .map((p) => (
                      <div key={p.goalId} className="text-xs text-muted" style={{ marginTop: 10 }}>
                        Projects to <strong>{formatCompact(p.projectedCorpus, draft.currency)}</strong> against{' '}
                        <strong>{formatCompact(p.inflatedTarget, draft.currency)}</strong> needed —{' '}
                        {p.onTrack ? (
                          <span className="text-positive">on track</span>
                        ) : (
                          <span className="text-negative">
                            needs {formatCompact(p.requiredMonthly, draft.currency)}/month
                          </span>
                        )}
                      </div>
                    ))}
                </div>
              ))}
            </div>
          )}

          {step === 5 && (
            <div className="grid grid-sidebar" style={{ alignItems: 'start' }}>
              <div className="stack">
                {RISK_QUESTIONS.map((q) => (
                  <div key={q.id}>
                    <div className="field-label" style={{ marginBottom: 7 }}>
                      {q.prompt}
                    </div>
                    <div className="stack-sm">
                      {q.options.map((opt, idx) => {
                        const checked = draft.riskAnswers[q.id] === idx;
                        return (
                          <label key={opt} className={`checkbox ${checked ? 'checked' : ''}`}>
                            <input
                              type="radio"
                              name={q.id}
                              checked={checked}
                              onChange={() => update((d) => void (d.riskAnswers[q.id] = idx))}
                            />
                            <span className="text-sm">{opt}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <div className="card" style={{ position: 'sticky', top: 12 }}>
                <div className="card-title" style={{ marginBottom: 12 }}>
                  Your risk assessment
                </div>
                {risk ? (
                  <div className="stack-sm">
                    <div className="row" style={{ gap: 14 }}>
                      <ScoreRing score={risk.effectiveScore} size={98} />
                      <div>
                        <div className="badge badge-accent">{risk.bucket}</div>
                        <div className="text-xs text-muted" style={{ marginTop: 7 }}>
                          Willingness {risk.toleranceScore}/100
                          <br />
                          Ability {risk.capacityScore}/100
                        </div>
                      </div>
                    </div>
                    <div className="text-xs text-muted">
                      The plan follows whichever is lower, so nobody is talked into a portfolio they
                      would abandon in a downturn.
                    </div>
                    {risk.drivers.slice(0, 3).map((d) => (
                      <div className="text-xs text-subtle" key={d}>
                        • {d}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-subtle">Answer the questions to see your profile.</div>
                )}
              </div>
            </div>
          )}
        </div>

        <footer className="onboarding-foot">
          <button
            className="btn btn-ghost"
            onClick={() => setStep((s) => Math.max(0, s - 1) as Step)}
            disabled={step === 0 || busy}
          >
            Back
          </button>

          <div className="row" style={{ gap: 10 }}>
            {step > 0 && step < 5 && preview && (
              <span className="text-xs text-subtle">
                Wellness preview: <strong className="text-sm">{preview.wellness.total}/100</strong>
              </span>
            )}
            {step > 0 && step < 5 && (
              <button
                className="btn btn-primary"
                onClick={() => setStep((s) => (s + 1) as Step)}
                disabled={!canAdvance() || busy}
              >
                Continue
              </button>
            )}
            {step === 5 && (
              <button className="btn btn-primary" onClick={finish} disabled={busy}>
                {busy ? 'Building your plan…' : 'See my plan'}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function newGoal(): Goal {
  return {
    id: `g-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: 'New goal',
    kind: 'custom',
    targetAmountToday: 0,
    targetYear: new Date().getUTCFullYear() + 10,
    currentSaved: 0,
    monthlyContribution: 0,
    contributionStepUpPct: 0,
    priority: 'important',
  };
}

/** Starting points, sized from the user's own expenses where that makes sense. */
const SUGGESTED_GOALS: {
  name: string;
  kind: Goal['kind'];
  years: number;
  priority: Goal['priority'];
  amount?: number;
  /** Multiple of monthly expenses, for goals that scale with lifestyle. */
  multiple?: number;
  inflation?: number;
}[] = [
  { name: 'Emergency Fund', kind: 'emergency', years: 2, priority: 'must_have', multiple: 6 },
  { name: 'Retirement', kind: 'retirement', years: 30, priority: 'must_have', multiple: 300 },
  { name: "Children's Education", kind: 'education', years: 12, priority: 'must_have', multiple: 120, inflation: 0.1 },
  { name: 'Home Down Payment', kind: 'home', years: 5, priority: 'important', multiple: 60 },
  { name: 'Car', kind: 'vehicle', years: 4, priority: 'aspirational', multiple: 20 },
  { name: 'Travel Fund', kind: 'travel', years: 2, priority: 'aspirational', multiple: 4 },
];
