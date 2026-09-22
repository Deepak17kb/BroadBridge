import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatCompact,
  formatPercent,
  type AgentAttachment,
  type AgentEvent,
  type AgentMessage,
  type AgentPlanStep,
  type Currency,
  type VerificationCheck,
} from '@wealth/shared';
import { api, IS_STATIC, streamAgent, type AgentCapabilities } from '../lib/api';
import { useLoadedProfile, useProfile } from '../state/ProfileContext';
import { AssumptionList, Badge, Callout, Card, Icon } from '../components/ui';
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
  const { setProfile } = useProfile();
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
  /** Set when this turn ran `update_plan`, so the edited plan is fetched once it is saved. */
  const planChangedRef = useRef(false);

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
    planChangedRef.current = false;

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
            if (event.tool === 'update_plan') planChangedRef.current = true;
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
        /*
         * The assistant can edit the plan, and the server saves that edit
         * before `done`. The browser kept its own copy, so every page showed
         * the old numbers - and the next edit anywhere PUT that stale copy
         * back, silently undoing what the assistant had just changed.
         */
        if (planChangedRef.current) {
          planChangedRef.current = false;
          api
            .getProfile(profile.id)
            .then(setProfile)
            .catch(() => setError('The plan was updated, but the new version could not be loaded - refresh to see it.'));
        }
      },
      onError: (message) => {
        setError(message);
        setStreaming(false);
        cancelRef.current = null;
      },
    });
  }

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
      {/*
        * The masthead states what makes this assistant different from a chat
        * box: it is wired to the engine and it shows its working. The three
        * figures are the evidence for that claim, so they are given as
        * figures rather than left inside the sentence.
        */}
      <header className="assistant-hero">
        <div className="assistant-hero-main">
          <div className="assistant-hero-badge">
            <span className="assistant-hero-pulse" aria-hidden="true" />
            Grounded in your plan
          </div>
          <h1>
            Ask anything about <span className="assistant-hero-em">your</span> money
          </h1>
          <p>
            Plain language in, real arithmetic out. The assistant reads your actual position, runs
            the same planning engine as every screen here, and shows every step it took.
          </p>
        </div>

        {capabilities && (
          <dl className="assistant-hero-stats">
            <div>
              <dt>Tools it can call</dt>
              <dd>{capabilities.tools.length}</dd>
            </div>
            <div>
              <dt>Reference notes</dt>
              <dd>{capabilities.knowledgeBase.length}</dd>
            </div>
            <div>
              <dt>Reasoning engine</dt>
              <dd className="assistant-hero-engine">{ENGINE_TEXT[capabilities.engine]}</dd>
            </div>
          </dl>
        )}
      </header>

      {IS_STATIC ? (
        <Callout tone="warning">
          This is the static build, which has no API server behind it — so the assistant is the one
          thing here that cannot run. It needs a model, and a model needs a key, which would be
          readable by anyone in a public bundle. Every other page works and is computed in your
          browser by the same finance engine. Clone the repo and run <code>npm run dev</code> to use
          the assistant.
        </Callout>
      ) : (
        capabilities?.engine === 'deterministic' && (
          <Callout tone="info">
            No model credentials are configured, so the assistant is planning and answering with its
            rule-based engine. It still classifies the question, runs the same tools and grounds
            every figure — the wording is just less fluent than a model's. Set{' '}
            <code>ANTHROPIC_API_KEY</code> or <code>GROQ_API_KEY</code> to switch it on.
          </Callout>
        )
      )}

      {/* Conversation history. Collapsed by default so it never competes with
          the answer, but one click from any past question. */}
      <Card>
        <div className="row-between wrap">
          <button
            className="btn btn-ghost"
            onClick={() => setHistoryOpen((open) => !open)}
            aria-expanded={historyOpen}
            aria-controls={historyOpen ? 'conversation-history' : undefined}
            disabled={sessions.length === 0}
          >
            <Icon name={historyOpen ? 'chevronDown' : 'chevronRight'} />
            Past conversations
            {sessions.length > 0 && <span className="text-muted">({sessions.length})</span>}
          </button>
          <div className="row gap-2">
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
              <Icon name="plus" /> New chat
            </button>
          </div>
        </div>

        {sessions.length === 0 && (
          <p className="text-xs text-subtle">
            Conversations are saved as you have them, and reopen here with their full reasoning
            trace.
          </p>
        )}

        {historyOpen && sessions.length > 0 && (
          <ul className="list-plain stack-sm" id="conversation-history">
            {sessions.map((s) => {
              const current = s.id === sessionId;
              return (
                <li key={s.id} className={`row-between wrap session-row ${current ? 'is-current' : ''}`.trim()}>
                  <button
                    className="btn btn-ghost session-open"
                    onClick={() => openSession(s.id)}
                    disabled={streaming || loadingSession !== null}
                    title={s.preview}
                    aria-current={current ? 'true' : undefined}
                  >
                    <span className="truncate">{s.preview || 'Untitled conversation'}</span>
                  </button>
                  <span className="text-xs text-subtle nowrap">
                    {s.messageCount} msg · {new Date(s.updatedAt).toLocaleDateString()}
                  </span>
                  {loadingSession === s.id && (
                    <span className="spinner" role="status" aria-label="Opening conversation" />
                  )}
                  {confirmDelete === s.id ? (
                    <span className="row gap-2">
                      <button className="btn btn-danger" onClick={() => removeSession(s.id)}>
                        Delete
                      </button>
                      <button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      className="btn btn-ghost btn-icon"
                      onClick={() => setConfirmDelete(s.id)}
                      aria-label={`Delete conversation: ${s.preview || 'untitled'}`}
                      disabled={streaming}
                    >
                      <Icon name="close" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="chat">
        <div className="chat-panel">
          {/* A log: screen readers announce each new turn, not every streamed token. */}
          <div
            className="chat-log"
            ref={logRef}
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-label="Conversation"
          >
            {messages.length === 0 && !streaming && (
              <div className="chat-empty stack-sm">
                <h2 className="card-title">What would you like to know?</h2>
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
                  <Icon name="sparkle" size={16} />
                </div>
                <div className="msg-body">
                  {streamedText ? (
                    <div className="msg-bubble typing-caret">{streamedText}</div>
                  ) : (
                    <div className="msg-bubble text-muted row gap-2">
                      <span className="spinner" aria-hidden="true" />
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
          </div>
        </div>

        <ReasoningTrace
          streaming={streaming}
          rationale={rationale}
          plan={activePlan}
          toolCalls={toolCalls}
          retrievals={retrievals}
          thoughts={thoughts}
          verification={activeVerification}
          capabilities={capabilities}
        />
      </div>
    </div>
  );
}

/** How a plan step or tool call stands, for screen readers; the icon shows it. */
const STATUS_TEXT: Record<AgentPlanStep['status'], string> = {
  pending: 'Waiting',
  running: 'Running',
  done: 'Done',
  skipped: 'Skipped',
  failed: 'Failed',
};

function TraceIcon({ status }: { status: AgentPlanStep['status'] }) {
  return (
    <span className={`trace-icon ${status}`} aria-hidden="true">
      {status === 'done' && <Icon name="check" size={12} />}
      {status === 'failed' && <Icon name="exclamation" size={12} />}
      {status === 'running' && <span className="trace-dot" />}
    </span>
  );
}

/**
 * The agent's reasoning, shown as it happens: the plan, each tool call with its
 * timing, what was retrieved, and the check of every figure against the tool
 * output that produced it.
 */
function ReasoningTrace({
  streaming,
  rationale,
  plan,
  toolCalls,
  retrievals,
  thoughts,
  verification,
  capabilities,
}: {
  streaming: boolean;
  rationale: string;
  plan: AgentPlanStep[];
  toolCalls: TraceToolCall[];
  retrievals: { title: string; score: number; snippet: string }[];
  thoughts: string[];
  verification: VerificationCheck[];
  capabilities: AgentCapabilities | null;
}) {
  // Counted from the checks on show, so the badge's colour agrees with its count.
  const grounded = verification.filter((v) => v.status === 'grounded').length;

  return (
    <aside className="trace" aria-label="Reasoning trace">
      <div className="trace-head">
        <h2 className="card-title">Reasoning trace</h2>
        {streaming && <span className="spinner" aria-hidden="true" />}
        <span className="flex-1" />
        {verification.length > 0 && (
          <Badge tone={grounded === verification.length ? 'positive' : 'warning'}>
            {grounded}/{verification.length} grounded
          </Badge>
        )}
      </div>
      <div className="trace-body">
        {plan.length === 0 && toolCalls.length === 0 && (
          <p className="text-sm text-subtle">
            Ask a question and the plan, every tool call and the grounding check will appear here as
            they happen.
          </p>
        )}

        {rationale && <p className="text-xs text-muted">{rationale}</p>}

        {plan.length > 0 && (
          <section>
            <h3 className="stat-label mb-2">Plan</h3>
            <ol className="list-plain">
              {plan.map((step) => (
                <li className="trace-step" key={step.id}>
                  <TraceIcon status={step.status} />
                  <div className="min-w-0">
                    <div className="trace-title">
                      <span className="sr-only">{STATUS_TEXT[step.status]}: </span>
                      {step.goal}
                    </div>
                    <div className="trace-detail num">{step.tool}</div>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}

        {toolCalls.length > 0 && (
          <>
            <hr className="divider" />
            <section>
              <h3 className="stat-label mb-2">Tool calls</h3>
              <ol className="list-plain">
                {toolCalls.map((call) => (
                  <li className="trace-step" key={call.id}>
                    <TraceIcon status={call.status} />
                    <div className="min-w-0">
                      <div className="row-between">
                        <span className="trace-title">
                          <span className="sr-only">{STATUS_TEXT[call.status]}: </span>
                          {call.label}
                        </span>
                        {call.ms !== undefined && <span className="trace-timing">{call.ms}ms</span>}
                      </div>
                      <div className="trace-detail num">{call.tool}</div>
                      {call.summary && (
                        <details className="disclosure mt-2">
                          <summary>What it returned</summary>
                          <div className="disclosure-body text-xs pre-wrap">{call.summary}</div>
                        </details>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </>
        )}

        {retrievals.length > 0 && (
          <>
            <hr className="divider" />
            <section>
              <h3 className="stat-label mb-2">Knowledge retrieved</h3>
              <ul className="list-plain stack-sm">
                {retrievals.map((hit) => (
                  <li key={hit.title}>
                    <div className="row-between">
                      <span className="text-sm strong">{hit.title}</span>
                      <span className="trace-timing">{hit.score.toFixed(2)}</span>
                    </div>
                    <div className="trace-detail">{hit.snippet}</div>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}

        {thoughts.length > 0 && (
          <>
            <hr className="divider" />
            {thoughts.map((t, i) => (
              <p className="text-xs text-muted" key={i}>
                {t}
              </p>
            ))}
          </>
        )}

        {verification.length > 0 && (
          <>
            <hr className="divider" />
            <section>
              <h3 className="stat-label mb-2">Grounding check</h3>
              <p className="text-xs text-subtle">
                Every figure in the answer is matched back against the tool output that produced it.
                An unmatched figure is flagged rather than trusted.
              </p>
              <ul className="list-plain stack-sm">
                {verification.map((check, i) => {
                  const ok = check.status === 'grounded';
                  return (
                    <li className="grounding-row" key={`${check.claim}-${i}`}>
                      <span
                        className={`dot grounding-dot ${ok ? 'grounded' : 'unmatched pulse'}`}
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <span className="text-sm num">
                          <span className="sr-only">{ok ? 'Grounded: ' : 'Not matched: '}</span>
                          {check.claim}
                        </span>
                        <div className="trace-detail">{check.evidence}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          </>
        )}

        {capabilities && (
          <>
            <hr className="divider" />
            <details className="disclosure">
              <summary>Tools available to the agent ({capabilities.tools.length})</summary>
              <div className="disclosure-body">
                <ul className="list-plain stack-sm">
                  {capabilities.tools.map((t) => (
                    <li key={t.name}>
                      <div className="text-sm strong">{t.label}</div>
                      <div className="text-xs text-subtle num">{t.name}</div>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          </>
        )}
      </div>
    </aside>
  );
}

/** One turn, plus any structured cards the agent attached to it. */
export function MessageBubble({ message, currency }: { message: AgentMessage; currency: Currency }) {
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
        <Icon name="sparkle" size={16} />
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
          <AttachmentCard key={i} attachment={attachment} currency={currency} />
        ))}

        {message.assumptions && message.assumptions.length > 0 && (
          <div className="mt-3">
            <AssumptionList assumptions={message.assumptions} title="Assumptions behind this answer" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A card the agent attached to an answer, drawn from the tool output the answer
 * was grounded on. Kinds without a card here render nothing.
 */
function AttachmentCard({ attachment, currency }: { attachment: AgentAttachment; currency: Currency }) {
  switch (attachment.kind) {
    case 'monte_carlo':
      return (
        <Card
          className="msg-attachment"
          title="Simulated outcomes"
          subtitle={`${formatPercent(attachment.data.successProbability, 0)} of paths reach the target`}
        >
          <MonteCarloFan result={attachment.data} currency={currency} height={190} />
        </Card>
      );
    case 'goal_projection':
      return (
        <Card
          className="msg-attachment"
          title={attachment.data.goalName}
          subtitle={`${attachment.data.yearsToGoal.toFixed(1)} years away`}
        >
          <div className="grid grid-pair gap-3">
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
      );
    case 'scenario':
      return (
        <Card className="msg-attachment" title={attachment.data.label} subtitle="Scenario result">
          <div className="grid grid-3 gap-3">
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
      );
    case 'actions':
      if (attachment.data.length === 0) return null;
      return (
        <Card className="msg-attachment" title="Recommended actions">
          <ol className="list-plain stack-sm">
            {attachment.data.slice(0, 4).map((a, idx) => (
              <li key={a.id} className="row gap-3 items-start">
                <span className="action-rank" aria-hidden="true">
                  {idx + 1}
                </span>
                <div className="min-w-0">
                  <div className="text-sm strong">{a.title}</div>
                  <div className="text-xs text-muted">
                    {a.impact.metric}:{' '}
                    {a.impact.unit === 'currency'
                      ? formatCompact(a.impact.value, currency)
                      : `${a.impact.value}${a.impact.unit === 'percent' ? '%' : ` ${a.impact.unit}`}`}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      );
    case 'debt_plan':
      return (
        <Card
          className="msg-attachment"
          title="Debt payoff plan"
          subtitle={`${attachment.data.strategy} · debt-free in ${attachment.data.monthsToDebtFree} months`}
        >
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
      );
    default:
      return null;
  }
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
