import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AgentEvent, AgentMessage } from '@wealth/shared';
import { streamAgent } from '../lib/api';
import { useProfile } from '../state/ProfileContext';
import { Callout, Icon } from './ui';
import { MessageBubble } from '../pages/Assistant';

/**
 * The assistant, reachable from every screen without leaving it.
 *
 * The full Assistant page stays the place to audit an answer - its reasoning
 * trace, conversation history and attachments are the point of that screen.
 * This is the quick path: ask from wherever you are, read the answer beside
 * the numbers it refers to, and open the full view when the working matters.
 *
 * It holds its own short conversation rather than sharing the page's, so
 * opening the dock never disturbs a session in progress on the Assistant tab.
 */

const DOCK_STARTERS = [
  'How am I doing overall?',
  'What should I do next?',
  'Explain what I am looking at.',
];

export function AssistantDock() {
  const { profile, snapshot } = useProfile();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);

  const navigate = useNavigate();
  const location = useLocation();
  const fabRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    fabRef.current?.focus();
  }, []);

  // Escape closes the dock, as it does the navigation drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Keep the newest turn in view as tokens arrive.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streamedText, open]);

  // Close the stream if the shell unmounts mid-answer.
  useEffect(() => () => cancelRef.current?.(), []);

  const suggestions = useMemo(() => {
    const dynamic: string[] = [];
    if (snapshot && snapshot.cashflow.emergencyFundGap > 0) {
      dynamic.push('How do I build my emergency fund fastest?');
    }
    const offTrack = snapshot?.goalProjections.find((g) => !g.onTrack);
    if (offTrack) dynamic.push(`Am I on track for ${offTrack.goalName}?`);
    return [...dynamic, ...DOCK_STARTERS].slice(0, 3);
  }, [snapshot]);

  const urgent = snapshot?.actions.filter((a) => a.priorityScore >= 70).length ?? 0;

  function ask(question: string) {
    const text = question.trim();
    if (!text || streaming || !profile) return;

    setMessages((m) => [
      ...m,
      { id: `dock-${Date.now()}`, role: 'user', content: text, at: new Date().toISOString() },
    ]);
    setInput('');
    setStreamedText('');
    setStatus('');
    setError(null);
    setStreaming(true);

    cancelRef.current = streamAgent(profile.id, text, sessionId, {
      onEvent: (event: AgentEvent) => {
        switch (event.type) {
          case 'thought':
            // The session id arrives as a trailing thought - plumbing, not
            // reasoning, so it is captured rather than shown.
            if (event.text.startsWith('Session ')) setSessionId(event.text.replace('Session ', ''));
            break;
          case 'tool_call':
            setStatus(event.label);
            break;
          case 'token':
            setStreamedText((t) => t + event.text);
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
        setStatus('');
        cancelRef.current = null;
      },
      onError: (message) => {
        setError(message);
        setStreaming(false);
        setStatus('');
        cancelRef.current = null;
      },
    });
  }

  // On the Assistant page the dock would be a second chat beside the real one.
  if (!profile || location.pathname === '/assistant') return null;

  return (
    <>
      <button
        ref={fabRef}
        className={`assistant-fab ${open ? 'is-hidden' : ''}`.trim()}
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls="assistant-dock"
        aria-label="Ask the AI assistant"
        title="Ask the AI assistant"
      >
        <span className="assistant-fab-icon">
          <Icon name="sparkle" size={22} />
        </span>
        <span className="assistant-fab-label">Ask the assistant</span>
        {urgent > 0 && !open && (
          <span className="assistant-fab-dot" aria-hidden="true" />
        )}
      </button>

      {open && (
        <section
          id="assistant-dock"
          className="assistant-dock"
          role="dialog"
          aria-label="AI assistant"
        >
          <header className="assistant-dock-head">
            <span className="assistant-dock-mark" aria-hidden="true">
              <Icon name="sparkle" size={18} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="assistant-dock-title truncate">AI Assistant</div>
              <div className="assistant-dock-sub truncate">
                {streaming ? status || 'Thinking' : 'Grounded in your plan'}
              </div>
            </div>
            <button
              className="btn btn-ghost btn-icon btn-sm"
              onClick={() => {
                cancelRef.current?.();
                setOpen(false);
                navigate('/assistant');
              }}
              aria-label="Open the full assistant, with its reasoning trace"
              title="Open the full assistant"
            >
              <Icon name="expand" />
            </button>
            <button
              className="btn btn-ghost btn-icon btn-sm"
              onClick={close}
              aria-label="Close the assistant"
              title="Close"
            >
              <Icon name="close" />
            </button>
          </header>

          <div
            className="assistant-dock-log"
            ref={logRef}
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-label="Conversation"
          >
            {messages.length === 0 && !streaming && (
              <div className="stack-sm">
                <p className="text-sm text-muted m-0">
                  Ask about anything on this screen. The assistant reads your actual position and
                  shows the figures it used.
                </p>
                <div className="suggestions mt-2">
                  {suggestions.map((s) => (
                    <button key={s} className="suggestion" onClick={() => ask(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} currency={profile.currency} />
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
                      {status || 'Working out how to answer…'}
                    </div>
                  )}
                </div>
              </div>
            )}

            {error && <Callout tone="negative">{error}</Callout>}
          </div>

          <div className="assistant-dock-foot">
            <form
              className="chat-form"
              onSubmit={(e) => {
                e.preventDefault();
                ask(input);
              }}
            >
              <input
                ref={inputRef}
                className="input"
                value={input}
                placeholder="Ask about your money…"
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
                    setStatus('');
                  }}
                >
                  Stop
                </button>
              ) : (
                <button
                  type="submit"
                  className="btn btn-primary btn-icon"
                  disabled={!input.trim()}
                  aria-label="Send"
                >
                  <Icon name="send" />
                </button>
              )}
            </form>
          </div>
        </section>
      )}
    </>
  );
}
