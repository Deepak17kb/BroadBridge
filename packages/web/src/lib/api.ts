import type {
  AgentEvent,
  ChatSession,
  FinancialSnapshot,
  GoalProjection,
  MonteCarloResult,
  RiskProfile,
  ScenarioLevers,
  ScenarioResult,
  UserProfile,
} from '@wealth/shared';

/**
 * Typed API client.
 *
 * In development everything goes through Vite's proxy on the same origin, so
 * there is no base URL and no CORS. In production `VITE_API_URL` points at the
 * API Gateway stage.
 */

/**
 * `import.meta.env` only exists once Vite has transformed the module, so it is
 * read defensively: the smoke-render tests import this file under plain Node,
 * where the whole object is undefined.
 */
const BASE = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_URL ?? '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (!res.ok) {
    // Surface the server's field-level validation detail rather than a generic
    // "request failed" - the forms use it to point at the offending input.
    let message = `Request failed (${res.status})`;
    let details: unknown;
    try {
      const body = (await res.json()) as { error?: string; details?: unknown };
      if (body.error) message = body.error;
      details = body.details;
    } catch {
      // Non-JSON error body; the status is all we have.
    }
    throw new ApiError(res.status, message, details);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface PersonaSummary {
  id: string;
  label: string;
  tagline: string;
  challenge: string;
  summary: {
    age: number;
    currency: string;
    monthlyIncome: number;
    goals: number;
    holdings: number;
  };
}

export interface HealthInfo {
  status: string;
  version: string;
  engine: 'bedrock' | 'anthropic' | 'deterministic';
  model: string | null;
  time: string;
}

export interface AgentCapabilities {
  engine: 'bedrock' | 'anthropic' | 'deterministic';
  model: string | null;
  maxSteps: number;
  simulationPaths: number;
  tools: { name: string; label: string; description: string }[];
  knowledgeBase: { id: string; title: string; tags: string[] }[];
}

export const api = {
  health: () => request<HealthInfo>('/health'),
  capabilities: () => request<AgentCapabilities>('/agent/capabilities'),
  personas: () => request<PersonaSummary[]>('/profiles/personas'),

  createProfile: (body: { personaId?: string; displayName?: string }) =>
    request<{ profile: UserProfile; snapshot: FinancialSnapshot }>('/profiles', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getProfile: (id: string) => request<UserProfile>(`/profiles/${id}`),

  saveProfile: (profile: UserProfile) =>
    request<{ profile: UserProfile; snapshot: FinancialSnapshot }>(`/profiles/${profile.id}`, {
      method: 'PUT',
      body: JSON.stringify(profile),
    }),

  patchProfile: (id: string, patch: Partial<UserProfile>) =>
    request<{ profile: UserProfile; snapshot: FinancialSnapshot }>(`/profiles/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteProfile: (id: string) => request<void>(`/profiles/${id}`, { method: 'DELETE' }),

  snapshot: (id: string) => request<FinancialSnapshot>(`/profiles/${id}/snapshot`),

  scoreRisk: (id: string, answers: Record<string, number>, persist = false) =>
    request<RiskProfile>(`/profiles/${id}/risk`, {
      method: 'POST',
      body: JSON.stringify({ answers, persist }),
    }),

  runScenario: (id: string, levers: ScenarioLevers, label?: string, paths?: number) =>
    request<ScenarioResult>(`/plan/${id}/scenario`, {
      method: 'POST',
      body: JSON.stringify({ levers, label, paths }),
    }),

  compareScenarios: (id: string, scenarios: { label?: string; levers: ScenarioLevers }[]) =>
    request<{ baseline: ScenarioResult['snapshot']; results: ScenarioResult[] }>(
      `/plan/${id}/scenarios/compare`,
      { method: 'POST', body: JSON.stringify({ scenarios }) },
    ),

  projectGoal: (id: string, goalId: string, body: { extraMonthly?: number; lumpSum?: number }) =>
    request<GoalProjection>(`/plan/${id}/goals/${goalId}/project`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  monteCarlo: (
    id: string,
    body: { years?: number; monthlyContribution?: number; riskBucket?: string; paths?: number },
  ) => request<MonteCarloResult>(`/plan/${id}/monte-carlo`, { method: 'POST', body: JSON.stringify(body) }),

  debtPlan: (id: string, extraMonthly = 0) =>
    request<{
      avalanche: import('@wealth/shared').DebtPayoffPlan;
      snowball: import('@wealth/shared').DebtPayoffPlan;
      interestSaved: number;
      monthsSaved: number;
    }>(`/plan/${id}/debt-plan`, { method: 'POST', body: JSON.stringify({ extraMonthly }) }),

  allocationLadder: (id: string, years?: number) =>
    request<
      {
        bucket: string;
        weights: Record<string, number>;
        expectedReturnPct: number;
        volatilityPct: number;
      }[]
    >(`/plan/${id}/allocation${years ? `?years=${years}` : ''}`),

  sessions: (id: string) =>
    request<{ id: string; updatedAt: string; messageCount: number; preview: string }[]>(
      `/agent/${id}/sessions`,
    ),

  session: (sessionId: string) => request<ChatSession>(`/agent/sessions/${sessionId}`),

  deleteSession: (sessionId: string) =>
    request<void>(`/agent/sessions/${sessionId}`, { method: 'DELETE' }),

  searchKnowledge: (query: string) =>
    request<{ id: string; title: string; score: number; snippet: string }[]>(
      `/agent/knowledge?q=${encodeURIComponent(query)}`,
    ),
};

/**
 * Opens the agent's SSE stream.
 *
 * `EventSource` is used rather than a fetch-based reader because it reconnects
 * on its own and the trace is strictly one-directional. The returned function
 * closes the stream, which the caller wires to unmount and to a stop button.
 */
export function streamAgent(
  profileId: string,
  message: string,
  sessionId: string | undefined,
  handlers: {
    onEvent: (event: AgentEvent) => void;
    onDone: () => void;
    onError: (error: string) => void;
  },
): () => void {
  const params = new URLSearchParams({ message });
  if (sessionId) params.set('sessionId', sessionId);
  const source = new EventSource(`${BASE}/api/agent/${profileId}/stream?${params.toString()}`);

  let finished = false;
  const close = () => {
    if (finished) return;
    finished = true;
    source.close();
  };

  const EVENTS = [
    'run_started',
    'plan',
    'thought',
    'tool_call',
    'tool_result',
    'retrieval',
    'token',
    'verification',
    'final',
    'error',
  ] as const;

  for (const name of EVENTS) {
    source.addEventListener(name, (event) => {
      try {
        handlers.onEvent(JSON.parse((event as MessageEvent).data) as AgentEvent);
      } catch {
        // A malformed frame should not kill the stream; the rest still arrives.
      }
    });
  }

  source.addEventListener('done', () => {
    close();
    handlers.onDone();
  });

  source.onerror = () => {
    // EventSource fires onerror on normal stream close too, so only report it
    // if the server never sent its terminating `done` event.
    if (finished) return;
    close();
    handlers.onError('The connection to the assistant was interrupted.');
  };

  return close;
}
