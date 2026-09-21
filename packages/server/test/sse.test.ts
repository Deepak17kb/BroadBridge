import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'express';
import { SseStream } from '../src/lib/sse.js';

/**
 * SSE framing tests.
 *
 * The agent recovers from a model failure by design: it emits an error event,
 * falls back to the deterministic engine and still delivers a full answer. That
 * recovery is only visible to the user if the browser keeps listening, which
 * makes the framing of the error event a correctness property rather than a
 * cosmetic one.
 */

/** Captures what actually reaches the socket. */
function recordingStream(): { stream: SseStream; wire: () => string } {
  const frames: string[] = [];
  const fake = {
    writeHead: () => undefined,
    flushHeaders: () => undefined,
    write: (chunk: string) => {
      frames.push(chunk);
      return true;
    },
    end: () => undefined,
    on: () => undefined,
  } as unknown as Response;

  return { stream: new SseStream(fake), wire: () => frames.join('') };
}

test('an agent error never travels under the SSE name "error"', () => {
  const { stream, wire } = recordingStream();

  stream.send({ type: 'error', message: 'rate limited', recoverable: true });
  stream.send({ type: 'thought', text: 'falling back' });
  stream.end();

  const sent = wire();

  // EventSource dispatches a server frame named `error` as the very same event
  // a dropped connection fires. The client cannot tell the two apart, so it
  // treats a recoverable agent snag as a dead socket, closes the stream, and
  // throws away the `final` answer the server is still about to send. That is
  // a blank screen for the user on a run the server completed successfully.
  assert.ok(!sent.includes('event: error'), 'the reserved SSE name must not reach the wire');
  assert.ok(sent.includes('event: agent_error'), 'the agent error still has to arrive');

  // Only the wire name is remapped: the payload keeps its own discriminant, so
  // every consumer that switches on `event.type` is unaffected.
  assert.ok(sent.includes('"type":"error"'), 'the payload keeps its own type');

  assert.ok(sent.includes('event: thought'), 'unaffected events keep their name');
  assert.ok(sent.includes('event: done'), 'the stream still terminates');
});

test('a closed stream stops writing', () => {
  const { stream, wire } = recordingStream();

  stream.end();
  stream.send({ type: 'thought', text: 'too late' });

  assert.ok(!wire().includes('too late'), 'nothing may be written after the stream ends');
});
