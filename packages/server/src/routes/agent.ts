import { Router } from 'express';
import { z } from 'zod';
import type { AgentEvent, AgentMessage, ChatSession } from '@wealth/shared';
import { activeModel, config } from '../config.js';
import { asyncHandler, notFound, parseBody } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { SseStream } from '../lib/sse.js';
import { getStore } from '../store/index.js';
import { runAgent } from '../agent/orchestrator.js';
import { KNOWLEDGE_BASE } from '../agent/knowledge/retriever.js';
import { TOOLS } from '../agent/tools.js';

/**
 * Agent endpoints.
 *
 * Two ways to ask the same question: `/stream` for the live trace the UI uses,
 * and a plain POST for anything that just wants the answer (tests, curl, a
 * future integration). Both run the identical orchestrator.
 */

export const router = Router();

const askSchema = z.object({
  message: z.string().min(1).max(2000),
  sessionId: z.string().max(80).optional(),
});

/** Introspection: what the agent can do. Used by the UI's capability panel. */
router.get(
  '/capabilities',
  asyncHandler(async (_req, res) => {
    res.json({
      engine: config.provider,
      model: activeModel(),
      maxSteps: config.maxAgentSteps,
      simulationPaths: config.simulationPaths,
      tools: TOOLS.map((t) => ({
        name: t.name,
        label: t.label,
        description: t.description,
      })),
      knowledgeBase: KNOWLEDGE_BASE.map((d) => ({ id: d.id, title: d.title, tags: d.tags })),
    });
  }),
);

async function loadSession(profileId: string, sessionId?: string): Promise<ChatSession> {
  const store = await getStore();
  if (sessionId) {
    const existing = await store.getSession(sessionId);
    if (existing) return existing;
  }
  return {
    id: sessionId ?? `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    profileId,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Streaming ask. Emits the plan, every tool call and result, the answer tokens
 * and the verification checks as Server-Sent Events.
 *
 * GET rather than POST so the browser's native EventSource can be used; the
 * message rides in the query string, which is why it is length-capped.
 */
router.get(
  '/:id/stream',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    const profile = await store.getProfile(req.params.id as string);
    if (!profile) throw notFound('Profile');

    const message = String(req.query.message ?? '').slice(0, 2000);
    if (!message.trim()) {
      res.status(400).json({ error: 'A message query parameter is required' });
      return;
    }
    const sessionId = req.query.sessionId ? String(req.query.sessionId) : undefined;
    const session = await loadSession(profile.id, sessionId);

    const stream = new SseStream(res);
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    const userMessage: AgentMessage = {
      id: `msg-${Date.now().toString(36)}`,
      role: 'user',
      content: message,
      at: new Date().toISOString(),
    };

    let latestProfile = profile;
    try {
      const answer = await runAgent({
        profile,
        message,
        history: session.messages,
        emit: (event: AgentEvent) => stream.send(event),
        onProfileChange: (updated) => {
          latestProfile = updated;
        },
        signal: controller.signal,
      });

      // Persist only if the client is still listening. An aborted request
      // should not leave a half-answered conversation behind.
      if (!controller.signal.aborted) {
        session.messages.push(userMessage, answer);
        await store.putSession(session);
        if (latestProfile !== profile) await store.putProfile(latestProfile);
      }
      stream.send({
        type: 'thought',
        text: `Session ${session.id}`,
      });
    } catch (error) {
      logger.error('stream failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      stream.send({
        type: 'error',
        message: 'The assistant could not complete that request.',
        recoverable: true,
      });
    } finally {
      stream.end();
    }
  }),
);

/** Non-streaming ask, for tests and integrations. */
router.post(
  '/:id/ask',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    const profile = await store.getProfile(req.params.id as string);
    if (!profile) throw notFound('Profile');

    const body = parseBody(askSchema, req.body);
    const session = await loadSession(profile.id, body.sessionId);
    const events: AgentEvent[] = [];
    let latestProfile = profile;

    const answer = await runAgent({
      profile,
      message: body.message,
      history: session.messages,
      emit: (event) => events.push(event),
      onProfileChange: (updated) => {
        latestProfile = updated;
      },
    });

    session.messages.push(
      {
        id: `msg-${Date.now().toString(36)}`,
        role: 'user',
        content: body.message,
        at: new Date().toISOString(),
      },
      answer,
    );
    await store.putSession(session);
    if (latestProfile !== profile) await store.putProfile(latestProfile);

    res.json({
      sessionId: session.id,
      message: answer,
      // The trace is returned too, so a non-streaming client still gets the
      // explainability rather than just the prose.
      trace: events.filter((e) => e.type !== 'token'),
    });
  }),
);

router.get(
  '/:id/sessions',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    const sessions = await store.listSessions(req.params.id as string);
    res.json(
      sessions.map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
        preview: s.messages.find((m) => m.role === 'user')?.content.slice(0, 120) ?? '',
      })),
    );
  }),
);

router.get(
  '/sessions/:sessionId',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    const session = await store.getSession(req.params.sessionId as string);
    if (!session) throw notFound('Session');
    res.json(session);
  }),
);

/**
 * Deletes one conversation.
 *
 * Idempotent by design: a second delete of the same id returns 204 rather than
 * 404. The client removes the row optimistically, so a retry after a dropped
 * response must not surface an error for work that already succeeded.
 */
router.delete(
  '/sessions/:sessionId',
  asyncHandler(async (req, res) => {
    const store = await getStore();
    await store.deleteSession(req.params.sessionId as string);
    res.status(204).end();
  }),
);

/** Knowledge-base search, exposed so the UI can show what grounds an answer. */
router.get(
  '/knowledge',
  asyncHandler(async (req, res) => {
    const { retrieve } = await import('../agent/knowledge/retriever.js');
    const query = String(req.query.q ?? '');
    if (!query.trim()) {
      res.json(KNOWLEDGE_BASE.map((d) => ({ id: d.id, title: d.title, tags: d.tags })));
      return;
    }
    res.json(retrieve(query, Number(req.query.limit) || 3));
  }),
);
