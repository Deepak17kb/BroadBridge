import {
  buildSnapshot,
  computeActionImpact,
  emptyProfile,
  optimiseGoalFunding,
  personaById,
  PERSONAS,
  planDebtPayoff,
  planningHorizon,
  portfolioExpectedReturn,
  portfolioVolatility,
  projectGoal,
  recommendAllocation,
  resolveAssumptions,
  returnForGoal,
  runMonteCarlo,
  runScenario,
  scoreRisk,
  type ChatSession,
  type ScenarioLevers,
  type UserProfile,
} from '@wealth/shared';
import { ApiError } from './apiError';

/**
 * The API, reimplemented against the browser.
 *
 * GitHub Pages serves files and nothing else, so on that deployment there is no
 * Express process to answer `/api/...`. Every route the client actually calls
 * is either a pure function of the profile or a read/write of it, and the
 * finance engine is already compiled into this bundle - `vite.config.ts` aliases
 * `@wealth/shared` at TypeScript source, so the browser runs the same maths the
 * server would have run. What is left for the server to do is hold the profile,
 * which `localStorage` does well enough for one person on one machine.
 *
 * So this is not a mock and not a reduced demo: the numbers come from the same
 * code and the same assumptions. The one thing it cannot do is the agent, which
 * needs a model and therefore a key that must never reach a public bundle -
 * `staticStreamAgent` says so rather than pretending.
 *
 * Selected at build time by `VITE_STATIC`, so the network client is tree-shaken
 * out of the Pages bundle and this file out of every other build.
 */

const STORAGE_KEY = 'wealth-navigator/static-store';

interface Persisted {
  profiles: Record<string, UserProfile>;
  sessions: Record<string, ChatSession>;
}

function read(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { profiles: {}, sessions: {}, ...(JSON.parse(raw) as Partial<Persisted>) };
  } catch {
    // Blocked storage, private browsing, or a value written by an older build.
    // An empty store is a valid starting point, so none of that is fatal.
  }
  return { profiles: {}, sessions: {} };
}

function write(data: Persisted): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Over quota or blocked. This call's result is still correct and still
    // returned; only the next reload loses it.
  }
}

function mustFind(id: string): UserProfile {
  const profile = read().profiles[id];
  // The server's 404 shape, so callers that already handle ApiError - the
  // reset-on-404 in ProfileContext, for one - behave identically here.
  if (!profile) throw new ApiError(404, 'Profile not found');
  return profile;
}

function save(profile: UserProfile): UserProfile {
  const data = read();
  const stored = { ...profile, updatedAt: new Date().toISOString() };
  data.profiles[stored.id] = stored;
  write(data);
  return structuredClone(stored);
}

function newId(): string {
  return `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export const staticApi = {
  health: async () => ({
    status: 'ok',
    version: 'static',
    engine: 'deterministic' as const,
    model: null,
    time: new Date().toISOString(),
  }),

  capabilities: async () => ({
    engine: 'deterministic' as const,
    model: null,
    maxSteps: 0,
    simulationPaths: 2000,
    tools: [],
    knowledgeBase: [],
  }),

  personas: async () =>
    PERSONAS.map((p) => ({
      id: p.id,
      label: p.label,
      tagline: p.tagline,
      challenge: p.challenge,
      summary: {
        age: p.profile.age,
        currency: p.profile.currency,
        monthlyIncome: p.profile.cashflow.monthlyNetIncome,
        goals: p.profile.goals.length,
        holdings: p.profile.holdings.length,
      },
    })),

  createProfile: async (body: { personaId?: string; displayName?: string }) => {
    const id = newId();
    let profile: UserProfile;
    if (body.personaId) {
      const persona = personaById(body.personaId);
      if (!persona) throw new ApiError(404, 'Persona "' + body.personaId + '" not found');
      profile = {
        ...structuredClone(persona.profile),
        id,
        displayName: body.displayName ?? persona.profile.displayName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    } else {
      profile = emptyProfile(id, body.displayName ?? 'New User');
    }
    const saved = save(profile);
    return { profile: saved, snapshot: buildSnapshot(saved) };
  },

  getProfile: async (id: string) => structuredClone(mustFind(id)),

  saveProfile: async (profile: UserProfile) => {
    if (profile.retirementAge <= profile.age) {
      throw new ApiError(400, 'Retirement age must be greater than current age');
    }
    const saved = save(profile);
    return { profile: saved, snapshot: buildSnapshot(saved) };
  },

  patchProfile: async (id: string, patch: Partial<UserProfile>) => {
    const existing = mustFind(id);
    const merged: UserProfile = {
      ...existing,
      ...patch,
      id: existing.id,
      cashflow: { ...existing.cashflow, ...(patch.cashflow ?? {}) },
      // Arrays replace wholesale, as on the server: merging them by index would
      // silently resurrect a deleted goal or holding.
      holdings: patch.holdings ?? existing.holdings,
      liabilities: patch.liabilities ?? existing.liabilities,
      goals: patch.goals ?? existing.goals,
      riskAnswers: { ...existing.riskAnswers, ...(patch.riskAnswers ?? {}) },
      updatedAt: new Date().toISOString(),
    };
    if (merged.retirementAge <= merged.age) {
      throw new ApiError(400, 'Retirement age must be greater than current age');
    }
    const saved = save(merged);
    return { profile: saved, snapshot: buildSnapshot(saved) };
  },

  deleteProfile: async (id: string) => {
    const data = read();
    delete data.profiles[id];
    for (const [key, session] of Object.entries(data.sessions)) {
      if (session.profileId === id) delete data.sessions[key];
    }
    write(data);
  },

  snapshot: async (id: string) => buildSnapshot(mustFind(id)),

  scoreRisk: async (id: string, answers: Record<string, number>, persist = false) => {
    const profile = mustFind(id);
    const risk = scoreRisk(profile, answers);
    if (persist) save({ ...profile, riskAnswers: answers });
    return risk;
  },

  runScenario: async (id: string, levers: ScenarioLevers, label?: string, paths?: number) =>
    runScenario({ profile: mustFind(id), levers, label, paths: paths ?? 2000 }),

  compareScenarios: async (id: string, scenarios: { label?: string; levers: ScenarioLevers }[]) => {
    const profile = mustFind(id);
    // One baseline across every scenario, as on the server: recomputing it per
    // scenario would be wasted work and would let the comparison drift.
    const baseline = buildSnapshot(profile);
    return {
      baseline: {
        netWorthAtRetirement: baseline.retirement.projectedCorpus,
        retirementReadiness: baseline.retirement.readinessRatio,
        wellnessScore: baseline.wellness.total,
        monthlySurplus: baseline.cashflow.monthlySurplus,
        goalsOnTrack: baseline.goalProjections.filter((g) => g.onTrack).length,
        goalsTotal: baseline.goalProjections.length,
      },
      results: scenarios.map((s, i) =>
        runScenario({
          profile,
          levers: s.levers,
          label: s.label,
          id: 'compare-' + i,
          baseline,
          paths: 1000,
        }),
      ),
    };
  },

  projectGoal: async (
    id: string,
    goalId: string,
    body: { extraMonthly?: number; lumpSum?: number },
  ) => {
    const profile = mustFind(id);
    const goal = profile.goals.find((g) => g.id === goalId);
    if (!goal) throw new ApiError(404, 'Goal not found');
    const assumptions = resolveAssumptions(profile);
    return projectGoal(goal, {
      annualReturn: returnForGoal(goal, profile, assumptions),
      assumptions,
      extraMonthly: body.extraMonthly,
      lumpSum: body.lumpSum,
    });
  },

  monteCarlo: async (
    id: string,
    body: { years?: number; monthlyContribution?: number; riskBucket?: string; paths?: number },
  ) => {
    const profile = mustFind(id);
    const snapshot = buildSnapshot(profile);
    const assumptions = resolveAssumptions(profile);
    const years = body.years ?? Math.max(1, snapshot.retirement.yearsToRetirement);
    const allocation = body.riskBucket
      ? recommendAllocation(body.riskBucket as Parameters<typeof recommendAllocation>[0], years)
      : snapshot.recommendedAllocation;
    return runMonteCarlo({
      // The projection's own inputs, so the simulation and the funding
      // percentage shown elsewhere describe the same plan.
      startingCorpus: snapshot.retirement.plan.startingCorpus,
      monthlyContribution: body.monthlyContribution ?? snapshot.retirement.plan.monthlyContribution,
      contributionStepUpPct: snapshot.retirement.plan.stepUpPct,
      years,
      expectedReturnPct: portfolioExpectedReturn(allocation, assumptions),
      volatilityPct: portfolioVolatility(allocation, assumptions),
      target: snapshot.retirement.corpusRequired,
      paths: body.paths ?? 2000,
      inflationPct: assumptions.inflationPct,
    });
  },

  debtPlan: async (id: string, extraMonthly = 0) => {
    const profile = mustFind(id);
    const avalanche = planDebtPayoff(profile, 'avalanche', extraMonthly);
    const snowball = planDebtPayoff(profile, 'snowball', extraMonthly);
    return {
      avalanche,
      snowball,
      interestSaved: snowball.totalInterestPaid - avalanche.totalInterestPaid,
      monthsSaved: snowball.monthsToDebtFree - avalanche.monthsToDebtFree,
    };
  },

  allocationLadder: async (id: string, years?: number) => {
    const profile = mustFind(id);
    const assumptions = resolveAssumptions(profile);
    const horizon = years ?? planningHorizon(profile);
    return (['Conservative', 'Moderate', 'Balanced', 'Growth', 'Aggressive'] as const).map(
      (bucket) => {
        const weights = recommendAllocation(bucket, horizon);
        return {
          bucket,
          weights,
          expectedReturnPct: portfolioExpectedReturn(weights, assumptions),
          volatilityPct: portfolioVolatility(weights, assumptions),
        };
      },
    );
  },

  impact: async (id: string, top = 3) =>
    computeActionImpact({ profile: mustFind(id), topN: Math.min(Math.max(top, 1), 10) }),

  optimiseGoals: async (id: string, surplusOverride?: number) =>
    optimiseGoalFunding({ profile: mustFind(id), surplusOverride }),

  sessions: async (id: string) =>
    Object.values(read().sessions)
      .filter((s) => s.profileId === id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => ({
        id: s.id,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
        preview: s.messages[0]?.content.slice(0, 120) ?? '',
      })),

  session: async (sessionId: string) => {
    const session = read().sessions[sessionId];
    if (!session) throw new ApiError(404, 'Session not found');
    return structuredClone(session);
  },

  deleteSession: async (sessionId: string) => {
    const data = read();
    delete data.sessions[sessionId];
    write(data);
  },

  searchKnowledge: async () => [],
};

/**
 * The agent cannot run here, and saying so is the only honest option.
 *
 * Every other route in this file is a pure function of the profile, so the
 * browser answers it exactly. The agent is not: it needs a model, and a model
 * needs a key, which would have to be embedded in a public bundle for anyone to
 * read. So the stream reports the limitation through the same error path a
 * dropped connection uses, and the page renders its normal error state rather
 * than hanging on a request that will never arrive.
 */
export function staticStreamAgent(
  _profileId: string,
  _message: string,
  _sessionId: string | undefined,
  handlers: { onError: (error: string) => void },
): () => void {
  const timer = setTimeout(
    () =>
      handlers.onError(
        'The assistant needs the API server, which this static deployment does not run. ' +
          'Clone the repo and run npm run dev to use it - every other page works here, ' +
          'computed in your browser by the same finance engine.',
      ),
    0,
  );
  return () => clearTimeout(timer);
}
