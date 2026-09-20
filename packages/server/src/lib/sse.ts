import type { Response } from 'express';
import type { AgentEvent } from '@wealth/shared';

/**
 * Server-Sent Events writer for the agent trace.
 *
 * SSE over WebSockets deliberately: the traffic is one-directional, it works
 * through API Gateway and CloudFront without a second protocol, and it
 * reconnects on its own. The client sees the agent plan, call tools and answer
 * as it happens rather than staring at a spinner - which is the difference
 * between "an AI answered" and "I watched it work".
 */
export class SseStream {
  private closed = false;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly res: Response) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Stops nginx/CloudFront from buffering the stream into one blob.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    // Comment frames keep intermediaries from timing out a quiet stream.
    this.heartbeat = setInterval(() => {
      if (!this.closed) this.res.write(': ping\n\n');
    }, 15_000);
    res.on('close', () => this.dispose());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(event: AgentEvent): void {
    if (this.closed) return;
    this.res.write(`event: ${event.type}\n`);
    this.res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  end(): void {
    if (this.closed) return;
    this.res.write('event: done\ndata: {}\n\n');
    this.dispose();
    this.res.end();
  }

  private dispose(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
  }
}
