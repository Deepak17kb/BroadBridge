import serverlessExpress from 'serverless-http';
import { createApp } from './app.js';

/**
 * API Gateway handler.
 *
 * The app is constructed at module scope so it is built once per cold start and
 * reused across invocations. `binary: false` keeps SSE frames as text, which is
 * what the browser's EventSource expects.
 */
const handler = serverlessExpress(createApp(), { binary: false });

export { handler };
export default handler;
