import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatCompact,
  formatPercent,
  type AgentEvent,
  type AgentMessage,
  type AgentPlanStep,
  type Currency,
  type VerificationCheck,
} from '@wealth/shared';
import { api, streamAgent, type AgentCapabilities } from '../lib/api';
import { useLoadedProfile } from '../state/ProfileContext';
import { AssumptionList, Badge, Callout, Card } from '../components/ui';
import { MonteCarloFan, TableToggle } from '../components/charts/Charts';

/**
 * The conversational assistant, with the agent's reasoning shown as it happens.
 *
 * The trace panel is the point of this screen. A chat box that returns a
 * paragraph is a black box; showing the plan, each tool call with its timing,
 * the documents retrieved and the grounding check turns the same answer into
 * something a user can audit. It is also the honest way to present an agent -
 * the work is real, so it can be shown.
 */

/** A Record rather than a ternary chain, so a new provider cannot be forgotten. */
const ENGINE_TEXT: Record<AgentCapabilities['engine'], string> = {
  bedrock: 'Claude on Bedrock',
  anthropic: 'Claude API',
  groq: 'Groq',
  deterministic: 'Deterministic engine',
};

/** One row of the conversation list, as `GET /api/agent/:id/sessions` returns it. */
interface SessionSummary {
  id: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}

interface TraceToolCall {
  id: string;
  tool: string;
  label: string;
  input: unknown;
  summary?: string;
  ms?: number;
  status: 'running' | 'done';
}

const STARTERS = [
  'How am I doing overall?',
  'What should I do next?',
  'Am I on track for retirement?',
  'What if I save 10,000 more each month?',
  'What are the chances I hit my target?',
  'Is my portfolio too risky?',
  'Should I pay off my loans or invest?',
  'Why does the emergency fund come first?',
];

export function Assistant() {
  const { profile, snapshot } = useLoadedProfile();
  const { currency } = profile;

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [plan, setPlan] = useState<AgentPlanStep[]>([]);
  const [rationale, setRationale] = useState('');
  const [toolCalls, setToolCalls] = useState<TraceToolCall[]>([]);
  const [retrievals, setRetrievals] = useState<{ title: string; score: number; snippet: string }[]>([]);
  const [verification, setVerification] = useState<VerificationCheck[]>([]);
  const [thoughts, setThoughts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loadingSession, setLoadingSession] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    api.capabilities().then(setCapabilities).catch(() => setCapabilities(null));
  }, []);

  const refreshSessions = useCallback(() => {
    api
      .sessions(profile.id)
      .then(setSessions)
      // A failed history load must never block asking a question.
      .catch(() => setSessions([]));
  }, [profile.id]);

  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

  // Keep the newest message in view as tokens arrive.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streamedText]);

  // Close the stream if the user navigates away mid-answer.
  useEffect(() => () => cancelRef.current?.(), []);

  /** Everything that belongs to one conversation, cleared together. */
  function resetTurnState() {
    setStreamedText('');
    setPlan([]);
    setRationale('');
    setToolCalls([]);
    setRetrievals([]);
    setVerification([]);
    setThoughts([]);
    setError(null);
  }

  function newChat() {
    if (streaming) cancelRef.current?.();
    setStreaming(false);
    setMessages([]);
    setSessionId(undefined);
    setInput('');
    resetTurnState();
  }

  /**
   * Reopens a stored conversation.
   *
   * The trace comes back with it: every assistant turn persists its own plan,
   * tool calls, verification and attachments, so a reloaded answer is as
   * auditable as a live one. Tool *summaries* and inputs are not stored - only
   * the name, label and timing - so restored calls show what ran and how long it
   * took, without inventing detail that was never persisted.
   */
  async function openSession(id: string) {
    if (streaming || loadingSession) return;
    setLoadingSession(id);
    try {
      const stored = await api.session(id);
      resetTurnState();
      setMessages(stored.messages);
      setSessionId(stored.id);
      setHistoryOpen(false);

      const lastTurn = [...stored.messages].reverse().find((m) => m.role === 'assistant');
      setPlan(lastTurn?.plan ?? []);
      setVerification(lastTurn?.verification ?? []);
      setToolCalls(
        (lastTurn?.toolCalls ?? []).map((call, i) => ({
          id: `${stored.id}-restored-${i}`,
          tool: call.tool,
          label: call.label,
          input: undefined,
          ms: call.ms,
          status: 'done' as const,
        })),
      );
    } catch {
      setError('That conversation could not be loaded.');
    } finally {
      setLoadingSession(null);
    }
  }

  async function removeSession(id: string) {
    // Optimistic: the row goes immediately and the delete is idempotent server
    // side, so a failed request cannot leave a half-deleted conversation.
    setSessions((list) => list.filter((s) => s.id !== id));
    setConfirmDelete(null);
    if (id === sessionId) newChat();
    try {
      await api.deleteSession(id);
    } finally {
      refreshSessions();
    }
  }

  function ask(question: string) {
    const text = question.trim();
    if (!text || streaming) return;

    setMessages((m) => [
      ...m,
      { id: `local-${Date.now()}`, role: 'user', content: text, at: new Date().toISOString() },
    ]);
    setInput('');
    setStreaming(true);
    resetTurnState();

    cancelRef.current = streamAgent(profile.id, text, sessionId, {
      onEvent: (event: AgentEvent) => {
        switch (event.type) {
          case 'plan':
            setPlan(event.steps);
            setRationale(event.rationale);
            break;
          case 'thought':
            // The session id arrives as a trailing thought; it is plumbing, not
            // reasoning, so it is captured rather than displayed.
            if (event.text.startsWith('Session ')) setSessionId(event.text.replace('Session ', ''));
            else setThoughts((t) => [...t, event.text]);
            break;
          case 'tool_call':
            setToolCalls((c) => [
              ...c,
              { id: event.id, tool: event.tool, label: event.label, input: event.input, status: 'running' },
            ]);
            break;
          case 'tool_result':
            setToolCalls((c) =>
              c.map((call) =>
                call.id === event.id
                  ? { ...call, summary: event.summary, ms: event.ms, status: 'done' }
                  : call,
              ),
            );
            break;
          case 'retrieval':
            setRetrievals(event.hits);
            break;
          case 'token':
            setStreamedText((t) => t + event.text);
            break;
          case 'verification':
            setVerification(event.checks);
            break;
          case 'final':
            setMessages((m) => [...m, event.message]);
            setStreamedText('');
            break;
          case 'error':
            setError(event.message);
            break;
          default:
            break;
        }
      },
      onDone: () => {
        setStreaming(false);
        cancelRef.current = null;
        // The turn is persisted server-side by now, so the list picks up a new
        // conversation or a bumped timestamp without a reload.
        refreshSessions();
      },
      onError: (message) => {
        setError(message);
        setStreaming(false);
        cancelRef.current = null;
      },
    });
  }

  const grounded = verification.filter((v) => v.status === 'grounded').length;
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const activeVerification = verification.length ? verification : (lastAssistant?.verification ?? []);
  const activePlan = plan.length ? plan : (lastAssistant?.plan ?? []);

  const suggestions = useMemo(() => {
    // Tailor the openers to what is actually wrong with this plan, so the
    // starters are about the user rather than about the product.
    const dynamic: string[] = [];
    if (snapshot.cashflow.emergencyFundGap > 0) dynamic.push('How do I build my emergency fund fastest?');
    if (snapshot.actions.some((a) => a.category === 'debt')) dynamic.push('Which debt should I clear first?');
    const worst = snapshot.goalProjections.find((g) => !g.onTrack);
    if (worst) dynamic.push(`Am I on track for ${worst.goalName}?`);
    return [...dynamic, ...STARTERS].slice(0, 6);
  }, [snapshot]);

  return (
    <div className="stack">
      <header className="page-head">
        <div className="row-between">
          <div>
            <h1>AI Assistant</h1>
            <p>
              Ask about your money in plain language. The assistant reads your actual position, runs
              the planning engine, and shows every step it took to reach an answer.
            </p>
          </div>
          {capabilities && (
            <div style={{ textAlign: 'right' }}>
              <Badge
                tone={
                  capabilities.engine === 'deterministic'
                    ? 'warning'
                    : capabilities.engine === 'bedrock'
                      ? 'positive'
                      : 'info'
                }
              >
                {ENGINE_TEXT[capabilities.engine]}
              </Badge>
              <div className="text-xs text-subtle" style={{ marginTop: 4 }}>
                {capabilities.tools.length} tools · {capabilities.knowledgeBase.length} reference notes
              </div>
            </div>
          )}
        </div>
      </header>

      {capabilities?.engine === 'deterministic' && (
        <Callout tone="info">
          No model credentials are configured, so the assistant is planning and answering with its
          rule-based engine. It still classifies the question, runs the same tools and grounds every
          figure — the wording is just less fluent than a model's. Set{' '}
          <code>ANTHROPIC_API_KEY</code> or <code>GROQ_API_KEY</code>, or deploy to AWS where the
          Lambda role reaches Bedrock, to switch it on.
        </Callout>
      )}

      {/* Conversation history. Collapsed by default so it never competes with
          the answer, but one click from any past question. */}
      <Card>
        <div className="row-between">
          <button
            className="btn btn-ghost"
            onClick={() => setHistoryOpen((open) => !open)}
            aria-expanded={historyOpen}
            disabled={sessions.length === 0}
          >
            {historyOpen ? '▾' : '▸'} Past conversations
            {sessions.length > 0 && (
              <span className="text-muted" style={{ marginLeft: 6 }}>
                ({sessions.length})
              </span>
            )}
          </button>
          <div className="row" style={{ gap: 8 }}>
            {sessionId && (
              <span className="text-xs text-subtle">
                {messages.length} message{messages.length === 1 ? '' : 's'} in this conversation
              </span>
            )}
            <button
              className="btn"
              onClick={newChat}
              disabled={streaming || (messages.length === 0 && !sessionId)}
            >
              New chat
            </button>
          </div>
        </div>

        {sessions.length === 0 && (
          <p className="text-xs text-subtle" style={{ marginTop: 8 }}>
            Conversations are saved as you have them, and reopen here with their full reasoning
            trace.
          </p>
        )}

        {historyOpen && sessions.length > 0 && (
          <div className="stack-sm" style={{ marginTop: 12 }}>
            {sessions.map((s) => (
              <div
                key={s.id}
                className="row-between session-row"
                style={{
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: s.id === sessionId ? 'var(--surface-hover)' : undefined,
                }}
              >
                <button
                  className="btn btn-ghost"
                  style={{ flex: 1, justifyContent: 'flex-start', textAlign: 'left', minWidth: 0 }}
                  onClick={() => openSession(s.id)}
                  disabled={streaming || loadingSession !== null}
                  title={s.preview}
                >
                  <span className="truncate">{s.preview || 'Untitled conversation'}</span>
                </button>
                <span className="text-xs text-subtle" style={{ whiteSpace: 'nowrap' }}>
                  {s.messageCount} msg · {new Date(s.updatedAt).toLocaleDateString()}
                </span>
                {loadingSession === s.id && <span className="spinner" />}
                {confirmDelete === s.id ? (
                  <span className="row" style={{ gap: 6 }}>
                    <button className="btn btn-danger" onClick={() => removeSession(s.id)}>
                      Delete
                    </button>
                    <button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    className="btn btn-ghost"
                    onClick={() => setConfirmDelete(s.id)}
                    aria-label={`Delete conversation: ${s.preview || 'untitled'}`}
                    disabled={streaming}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <div className="chat">
        <div className="chat-panel">
          <div className="chat-log" ref={logRef}>
            {messages.length === 0 && !streaming && (
              <div className="stack-sm" style={{ padding: '18px 4px' }}>
                <div className="strong">What would you like to know?</div>
                <p className="text-sm text-muted">
                  I can read your position, project any goal, run what-if scenarios against thousands
                  of simulated markets, compare options, and explain the reasoning behind any
                  recommendation. Try one of these:
                </p>
                <div className="suggestions">
                  {suggestions.map((s) => (
                    <button key={s} className="suggestion" onClick={() => ask(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} currency={currency} />
            ))}

            {streaming && (
              <div className="msg assistant">
                <div className="msg-avatar" aria-hidden="true">
                  AI
                </div>
                <div className="msg-body">
                  {streamedText ? (
                    <div className="msg-bubble typing-caret">{streamedText}</div>
                  ) : (
                    <div className="msg-bubble text-muted row" style={{ gap: 9 }}>
                      <span className="spinner" />
                      {toolCalls.at(-1)?.label ?? 'Working out how to answer…'}
                    </div>
                  )}
                </div>
              </div>
            )}

            {error && <Callout tone="negative">{error}</Callout>}
          </div>

          <div className="chat-input">
            {messages.length > 0 && !streaming && (
              <div className="suggestions">
                {suggestions.slice(0, 3).map((s) => (
                  <button key={s} className="suggestion" onClick={() => ask(s)}>
                    {s}
                  </button>
                ))}
              </div>
            )}
            <form
              className="chat-form"
              onSubmit={(e) => {
                e.preventDefault();
                ask(input);
              }}
            >
              <input
                className="input"
                value={input}
                placeholder="Ask about your goals, portfolio or a what-if…"
                onChange={(e) => setInput(e.target.value)}
                disabled={streaming}
                aria-label="Your question"
              />
              {streaming ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    cancelRef.current?.();
                    setStreaming(false);
                  }}
                >
                  Stop
                </button>
              ) : (
                <button type="submit" className="btn btn-primary" disabled={!input.trim()}>
                  Ask
                </button>
              )}
            </form>
            <div className="text-xs text-subtle" style={{ marginTop: 7 }}>
              Synthetic data, illustrative projections, not financial advice.
            </div>
          </div>
        </div>

        {/* Reasoning trace. */}
        <div className="trace">
          <div className="trace-head">
            <span className="card-title">Reasoning trace</span>
            {streaming && <span className="spinner" />}
            <span className="topbar-spacer" />
            {activeVerification.length > 0 && (
              <Badge tone={grounded === activeVerification.length ? 'positive' : 'warning'}>
                {activeVerification.filter((v) => v.status === 'grounded').length}/
                {activeVerification.length} grounded
              </Badge>
            )}
          </div>
          <div className="trace-body">
            {activePlan.length === 0 && toolCalls.length === 0 && (
              <p className="text-sm text-subtle">
                Ask a question and the plan, every tool call and the grounding check will appear here
                as they happen.
              </p>
            )}

            {rationale && (
              <p className="text-xs text-muted" style={{ marginBottom: 13 }}>
                {rationale}
              </p>
            )}

            {activePlan.length > 0 && (
              <>
                <div className="stat-label" style={{ marginBottom: 9 }}>
                  Plan
                </div>
                {activePlan.map((step) => (
                  <div className="trace-step" key={step.id}>
                    <span className={`trace-icon ${step.status === 'done' ? 'done' : step.status === 'running' ? 'running' : step.status === 'failed' ? 'failed' : ''}`}>
                      {step.status === 'done' ? '✓' : step.status === 'failed' ? '!' : step.status === 'running' ? '•' : ''}
                    </span>
                    <div>
                      <div className="trace-title">{step.goal}</div>
                      <div className="trace-detail num">{step.tool}</div>
                    </div>
                  </div>
                ))}
              </>
            )}

            {toolCalls.length > 0 && (
              <>
                <div className="divider" style={{ margin: '11px 0' }} />
                <div className="stat-label" style={{ marginBottom: 9 }}>
                  Tool calls
                </div>
                {toolCalls.map((call) => (
                  <div className="trace-step" key={call.id}>
                    <span className={`trace-icon ${call.status === 'done' ? 'done' : 'running'}`}>
                      {call.status === 'done' ? '✓' : '•'}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="row-between">
                        <span className="trace-title">{call.label}</span>
                        {call.ms !== undefined && <span className="trace-timing">{call.ms}ms</span>}
                      </div>
                      <div className="trace-detail num">{call.tool}</div>
                      {call.summary && (
                        <details className="disclosure" style={{ marginTop: 6 }}>
                          <summary>What it returned</summary>
                          <div className="disclosure-body text-xs" style={{ whiteSpace: 'pre-wrap' }}>
                            {call.summary}
                          </div>
                        </details>
                      )}
                    </div>
                  </div>
                ))}
              </>
            )}

            {retrievals.length > 0 && (
              <>
                <div className="divider" style={{ margin: '11px 0' }} />
                <div className="stat-label" style={{ marginBottom: 9 }}>
                  Knowledge retrieved
                </div>
                {retrievals.map((hit) => (
                  <div key={hit.title} style={{ marginBottom: 10 }}>
                    <div className="row-between">
                      <span className="text-sm strong">{hit.title}</span>
                      <span className="trace-timing">{hit.score.toFixed(2)}</span>
                    </div>
                    <div className="trace-detail">{hit.snippet}</div>
                  </div>
                ))}
              </>
            )}

            {thoughts.length > 0 && (
              <>
                <div className="divider" style={{ margin: '11px 0' }} />
                {thoughts.map((t, i) => (
                  <p className="text-xs text-muted" key={i}>
                    {t}
                  </p>
                ))}
              </>
            )}

            {activeVerification.length > 0 && (
              <>
                <div className="divider" style={{ margin: '11px 0' }} />
                <div className="stat-label" style={{ marginBottom: 6 }}>
                  Grounding check
                </div>
                <p className="text-xs text-subtle" style={{ marginBottom: 9 }}>
                  Every figure in the answer is matched back against the tool output that produced
                  it. An unmatched figure is flagged rather than trusted.
                </p>
                {activeVerification.map((check, i) => (
                  <div className="row" key={i} style={{ gap: 7, marginBottom: 6, alignItems: 'flex-start' }}>
                    <span
                      className={`dot ${check.status === 'grounded' ? '' : 'pulse'}`}
                      style={{
                        background: check.status === 'grounded' ? 'var(--positive)' : 'var(--warning)',
                        marginTop: 6,
                      }}
                    />
                    <div style={{ minWidth: 0 }}>
                      <span className="text-sm num">{check.claim}</span>
                      <div className="trace-detail">{check.evidence}</div>
                    </div>
                  </div>
                ))}
              </>
            )}

            {capabilities && (
              <>
                <div className="divider" style={{ margin: '11px 0' }} />
                <details className="disclosure">
                  <summary>Tools available to the agent ({capabilities.tools.length})</summary>
                  <div className="disclosure-body stack-sm">
                    {capabilities.tools.map((t) => (
                      <div key={t.name}>
                        <div className="text-sm strong">{t.label}</div>
                        <div className="text-xs text-subtle num">{t.name}</div>
                      </div>
                    ))}
                  </div>
                </details>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One turn, plus any structured cards the agent attached to it. */
function MessageBubble({ message, currency }: { message: AgentMessage; currency: Currency }) {
  if (message.role === 'user') {
    return (
      <div className="msg user">
        <div className="msg-avatar" aria-hidden="true">
          You
        </div>
        <div className="msg-body">
          <div className="msg-bubble">{message.content}</div>
        </div>
      </div>
    );
  }

  const groundedCount = message.verification?.filter((v) => v.status === 'grounded').length ?? 0;

  return (
    <div className="msg assistant">
      <div className="msg-avatar" aria-hidden="true">
        AI
      </div>
      <div className="msg-body">
        <div className="msg-bubble" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />

        <div className="msg-meta">
          {message.toolCalls?.map((t, i) => (
            <Badge key={`${t.tool}-${i}`}>
              {t.label} · {t.ms}ms
            </Badge>
          ))}
          {message.verification && message.verification.length > 0 && (
            <Badge tone={groundedCount === message.verification.length ? 'positive' : 'warning'}>
              {groundedCount}/{message.verification.length} figures grounded
            </Badge>
          )}
          {message.engine && (
            <Badge tone={message.engine === 'deterministic' ? 'warning' : 'info'}>
              {message.engine === 'deterministic' ? 'rule engine' : message.engine}
            </Badge>
          )}
        </div>

        {message.attachments?.map((attachment, i) => (
          <div key={i} style={{ marginTop: 11 }}>
            {attachment.kind === 'monte_carlo' && (
              <Card title="Simulated outcomes" subtitle={`${formatPercent(attachment.data.successProbability, 0)} of paths reach the target`}>
                <MonteCarloFan result={attachment.data} currency={currency} height={190} />
              </Card>
            )}
            {attachment.kind === 'goal_projection' && (
              <Card title={attachment.data.goalName} subtitle={`${attachment.data.yearsToGoal.toFixed(1)} years away`}>
                <div className="grid grid-2" style={{ gap: 12 }}>
                  <div>
                    <div className="stat-label">Needed then</div>
                    <div className="text-sm num strong">
                      {formatCompact(attachment.data.inflatedTarget, currency)}
                    </div>
                  </div>
                  <div>
                    <div className="stat-label">Projected</div>
                    <div className={`text-sm num strong ${attachment.data.onTrack ? 'text-positive' : 'text-negative'}`}>
                      {formatCompact(attachment.data.projectedCorpus, currency)}
                    </div>
                  </div>
                </div>
                <AssumptionList assumptions={attachment.data.assumptions} />
              </Card>
            )}
            {attachment.kind === 'scenario' && (
              <Card title={attachment.data.label} subtitle="Scenario result">
                <div className="grid grid-3" style={{ gap: 12 }}>
                  <div>
                    <div className="stat-label">Corpus</div>
                    <div className="text-sm num strong">
                      {formatCompact(attachment.data.snapshot.netWorthAtRetirement, currency)}
                    </div>
                  </div>
                  <div>
                    <div className="stat-label">vs today</div>
                    <div
                      className={`text-sm num strong ${attachment.data.deltaVsBaseline.netWorthAtRetirement >= 0 ? 'text-positive' : 'text-negative'}`}
                    >
                      {attachment.data.deltaVsBaseline.netWorthAtRetirement >= 0 ? '+' : '-'}
                      {formatCompact(Math.abs(attachment.data.deltaVsBaseline.netWorthAtRetirement), currency)}
                    </div>
                  </div>
                  <div>
                    <div className="stat-label">Success</div>
                    <div className="text-sm num strong">
                      {formatPercent(attachment.data.monteCarlo.successProbability, 0)}
                    </div>
                  </div>
                </div>
                <MonteCarloFan result={attachment.data.monteCarlo} currency={currency} height={180} />
              </Card>
            )}
            {attachment.kind === 'actions' && attachment.data.length > 0 && (
              <Card title="Recommended actions">
                <div className="stack-sm">
                  {attachment.data.slice(0, 4).map((a, idx) => (
                    <div key={a.id} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                      <span className="action-rank">{idx + 1}</span>
                      <div style={{ minWidth: 0 }}>
                        <div className="text-sm strong">{a.title}</div>
                        <div className="text-xs text-muted">
                          {a.impact.metric}:{' '}
                          {a.impact.unit === 'currency'
                            ? formatCompact(a.impact.value, currency)
                            : `${a.impact.value}${a.impact.unit === 'percent' ? '%' : ` ${a.impact.unit}`}`}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
            {attachment.kind === 'debt_plan' && (
              <Card title="Debt payoff plan" subtitle={`${attachment.data.strategy} · debt-free in ${attachment.data.monthsToDebtFree} months`}>
                <TableToggle label="Payoff order">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Debt</th>
                        <th className="right">Cleared in</th>
                        <th className="right">Interest paid</th>
                      </tr>
                    </thead>
                    <tbody>
                      {attachment.data.order.map((o) => (
                        <tr key={o.liabilityId}>
                          <td>{o.name}</td>
                          <td className="right num">month {o.payoffMonth}</td>
                          <td className="right num">{formatCompact(o.interestPaid, currency)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableToggle>
              </Card>
            )}
          </div>
        ))}

        {message.assumptions && message.assumptions.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <AssumptionList assumptions={message.assumptions} title="Assumptions behind this answer" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Minimal, escaping-first Markdown for the subset the assistant emits: bold,
 * italics, inline code and paragraphs.
 *
 * HTML is escaped *before* any formatting is applied, so model output cannot
 * inject markup - the only tags in the result are the ones generated here.
 */
function renderMarkdown(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_([^_]+)_/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n{2,}/g, '<br><br>')
    .replace(/\n/g, '<br>');
}
