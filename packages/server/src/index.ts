import { createApp } from './app.js';
import { activeModel, config } from './config.js';
import { logger } from './lib/logger.js';

/**
 * Local and container entrypoint. The Lambda deployment uses `lambda.ts`
 * instead, wrapping the same app.
 */
const app = createApp();

const server = app.listen(config.port, () => {
  logger.info('AI Wealth Navigator API listening', {
    port: config.port,
    engine: config.provider,
    model: activeModel() ?? 'none (deterministic engine)',
    store: config.tableName ? `dynamodb:${config.tableName}` : 'memory',
  });
});

/**
 * A busy port is the most common way `npm run dev` fails, usually because an
 * earlier run is still alive. Node's default is an unhandled 'error' event and
 * a stack trace, which buries the one fact that matters.
 */
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`Port ${config.port} is already in use`, {
      hint: `Another instance is probably still running. Stop it, or start this one on a different port with PORT=4001.`,
    });
    process.exit(1);
  }
  throw error;
});

// SSE streams are long-lived; give them time to drain before the process exits.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info('shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
