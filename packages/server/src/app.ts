import cors from 'cors';
import express, { type Express } from 'express';
import { DEFAULT_ASSUMPTIONS, RISK_QUESTIONS } from '@wealth/shared';
import { activeModel, config } from './config.js';
import { errorMiddleware } from './lib/http.js';
import { logger } from './lib/logger.js';
import { getStore } from './store/index.js';
import { router as profilesRouter } from './routes/profiles.js';
import { router as planningRouter } from './routes/planning.js';
import { router as agentRouter } from './routes/agent.js';

/**
 * Express app factory.
 *
 * Exported as a factory rather than a module-level singleton so the Lambda
 * handler, the local server and the test suite all build their own instance -
 * which keeps tests independent of each other.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(
    cors({
      origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
      credentials: false,
    }),
  );
  // Profiles carry full holdings and goal lists, so the default 100kb is tight.
  app.use(express.json({ limit: '1mb' }));

  // Request logging, minus the SSE stream which would log a line per token.
  app.use((req, res, next) => {
    if (req.path.endsWith('/stream')) return next();
    const started = Date.now();
    res.on('finish', () => {
      logger.debug('request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    });
    next();
  });

  /** Liveness probe for the load balancer and CI smoke tests. */
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      version: '1.0.0',
      engine: config.provider,
      model: activeModel(),
      time: new Date().toISOString(),
    });
  });

  /** Readiness: includes the store, so a broken table shows up here. */
  app.get('/api/ready', async (_req, res) => {
    try {
      const store = await getStore();
      res.json({ status: 'ready', store: store.kind, engine: config.provider });
    } catch (error) {
      res.status(503).json({
        status: 'unavailable',
        message: error instanceof Error ? error.message : 'store unavailable',
      });
    }
  });

  /**
   * The assumptions ledger. Published as an endpoint because "make assumptions
   * visible" only means something if they are inspectable from outside the UI.
   */
  app.get('/api/meta/assumptions', (_req, res) => {
    res.json({
      assumptions: DEFAULT_ASSUMPTIONS,
      riskQuestions: RISK_QUESTIONS,
      disclaimer:
        'All figures are illustrative, computed from synthetic data, and are not financial advice. Expected returns are long-run planning assumptions, not forecasts.',
    });
  });

  app.use('/api/profiles', profilesRouter);
  app.use('/api/plan', planningRouter);
  app.use('/api/agent', agentRouter);

  app.use((req, res) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
  });
  app.use(errorMiddleware);

  return app;
}
