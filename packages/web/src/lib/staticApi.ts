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
  type AgentEvent,
  type ChatSession,
  type ScenarioLevers,
  type UserProfile,
} from '@wealth/shared';
import { readModelKey } from './agent/browserKey';
import { DEFAULT_BROWSER_MODEL } from './agent/browserLlm';
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
 * code and the same assumptions. The agent runs here too, in the browser -
 * deterministically by default, or against a real model once the visitor
 * connects a key of their own, which is the only way a public bundle can reach
 * one without publishing somebody's credential.
 *
 * Selected at build time by `VITE_STATIC`, so the network client is tree-shaken
 * out of the Pages bundle and this file out of every other build.
 */

const STORAGE_KEY = 'wealth-navigator/static-store';

export interface Persisted {
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

/**
 * The store, for the in-browser agent.
 *
 * Exported rather than re-implemented next door: the agent has to read the
 * profile it is answering about and append to the conversation it is part of,
 * and a second copy of the storage key and the record shape is a drift waiting
 * to happen.
 */
export const browserStore = { read, write };

export const staticApi = {
  health: async () => {
    const connected = readModelKey();
    return {
      status: 'ok',
      version: 'static',
      engine: connected ? ('groq' as const) : ('deterministic' as const),
      model: connected ? DEFAULT_BROWSER_MODEL : null,
      time: new Date().toISOString(),
    };
  },

  /**
   * The real catalogue, not a placeholder: the agent in this build is the same
   * one the server runs, so the panel reports what it can actually reach.
   *
   * Loaded dynamically like the agent itself. A static import here would pull
   * the whole orchestrator into the entry chunk, and every visitor would
   * download the agent to render a page that never asks it anything.
   */
  capabilities: async () => {
    const [{ TOOLS }, { KNOWLEDGE_BASE }] = await Promise.all([
      import('@agent/tools.js'),
      import('@agent/knowledge/corpus.js'),
    ]);
    const connected = readModelKey();
    return {
      // Reported from what is stored now, not from a build-time constant: the
      // visitor can connect or disconnect a key between two questions.
      engine: connected ? ('groq' as const) : ('deterministic' as const),
      model: connected ? DEFAULT_BROWSER_MODEL : null,
      maxSteps: 6,
      simulationPaths: 2000,
      tools: TOOLS.map((t) => ({ name: t.name, label: t.label, description: t.description })),
      knowledgeBase: KNOWLEDGE_BASE.map((d) => ({ id: d.id, title: d.title, tags: d.tags })),
    };
  },

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

  searchKnowledge: async (query: string) => {
    // The retriever rather than an empty list: it is BM25 over the same corpus,
    // and it is already in the bundle because the agent uses it.
    const { retrieve } = await import('@agent/knowledge/retriever.js');
    // `content` is the model's grounding context and is far too long for a
    // list; the wire shape carries the snippet only.
    return retrieve(query).map(({ id, title, score, snippet }) => ({ id, title, score, snippet }));
  },
};

/**
 * The agent, run in the browser.
 *
 * There is no server here to stream from, so the client runs the orchestrator
 * itself - the same one, imported as source. It loads on first use rather than
 * with the app: the agent and its knowledge base are a sizeable chunk that most
 * visits never open, and a dynamic import keeps them out of the initial bundle.
 *
 * The one thing it cannot do is call a model, because a model needs a key and a
 * key in a public bundle is readable by anyone. So it runs in deterministic
 * mode - planning, calling tools, grounding every figure, narrating from
 * templates. See `agent/browserAgent.ts`.
 */
export function staticStreamAgent(
  profileId: string,
  message: string,
  sessionId: string | undefined,
  handlers: {
    onEvent: (event: AgentEvent) => void;
    onDone: () => void;
    onError: (error: string) => void;
  },
): () => void {
  let cancel: (() => void) | null = null;
  let cancelled = false;

  void import('./agent/browserAgent')
    .then(({ runBrowserAgent }) => {
      if (cancelled) return;
      cancel = runBrowserAgent(profileId, message, sessionId, handlers);
    })
    .catch(() => {
      if (!cancelled) handlers.onError('The assistant could not be loaded. Reload and try again.');
    });

  return () => {
    cancelled = true;
    cancel?.();
  };
}
