import type { AgentEvent, AgentMessage, ChatSession } from '@wealth/shared';
import { runAgent } from '@agent/orchestrator.js';
import { browserStore } from '../staticApi';

/**
 * The agent, running in the browser.
 *
 * On the static build there is no server to stream Server-Sent Events from, so
 * the client runs the orchestrator itself. This is the *same* orchestrator the
 * server runs - imported as source, like the finance engine - so the plan, the
 * fourteen tools, the knowledge retrieval and the grounding check are identical
 * rather than reimplemented. What differs is only that `getLlm()` returns null
 * here (see `llmShim.ts`), which puts the agent in deterministic mode: it still
 * reasons, still calls tools, still grounds every figure, and writes its prose
 * from templates instead of from a model.
 *
 * The event shape matches the SSE path exactly, so `Assistant.tsx` consumes
 * both through one code path and cannot tell which one answered it.
 */

/** Mirrors the server's session rule: a conversation belongs to one profile. */
function loadSession(profileId: string, sessionId?: string): ChatSession {
  const data = browserStore.read();
  if (sessionId) {
    const existing = data.sessions[sessionId];
    // A foreign session starts a fresh one rather than being continued, or this
    // turn would be appended to another profile's transcript.
    if (existing && existing.profileId === profileId) return existing;
  }
  const now = new Date().toISOString();
  return {
    id: `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    profileId,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function runBrowserAgent(
  profileId: string,
  message: string,
  sessionId: string | undefined,
  handlers: {
    onEvent: (event: AgentEvent) => void;
    onDone: () => void;
    onError: (error: string) => void;
  },
): () => void {
  const controller = new AbortController();
  let finished = false;

  const profile = browserStore.read().profiles[profileId];
  if (!profile) {
    // Nothing to reason about. Reported through the same path a dropped
    // connection uses, so the page renders its normal error state.
    const timer = setTimeout(() => handlers.onError('That profile could not be found.'), 0);
    return () => clearTimeout(timer);
  }

  const session = loadSession(profileId, sessionId);
  const userMessage: AgentMessage = {
    id: `msg-${Date.now().toString(36)}`,
    role: 'user',
    content: message,
    at: new Date().toISOString(),
  };

  void (async () => {
    let latestProfile = profile;
    try {
      const answer = await runAgent({
        profile,
        message,
        history: session.messages,
        emit: (event: AgentEvent) => {
          if (!controller.signal.aborted) handlers.onEvent(event);
        },
        onProfileChange: (updated) => {
          latestProfile = updated;
        },
        signal: controller.signal,
      });

      // Persist only if the user is still listening - an abandoned run must not
      // leave a half-answered conversation behind.
      if (!controller.signal.aborted) {
        const data = browserStore.read();
        session.messages.push(userMessage, answer);
        session.updatedAt = new Date().toISOString();
        data.sessions[session.id] = session;
        // A tool may have applied an action to the plan mid-answer.
        if (latestProfile !== profile) data.profiles[latestProfile.id] = latestProfile;
        browserStore.write(data);

        // How the page learns the session id, exactly as the SSE route does.
        handlers.onEvent({ type: 'thought', text: `Session ${session.id}` });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('browser agent failed', error);
        handlers.onEvent({
          type: 'error',
          message: 'The assistant could not complete that request.',
          recoverable: true,
        });
      }
    } finally {
      if (!finished && !controller.signal.aborted) {
        finished = true;
        handlers.onDone();
      }
    }
  })();

  return () => {
    if (finished) return;
    finished = true;
    controller.abort();
  };
}
