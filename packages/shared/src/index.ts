/**
 * @wealth/shared - the single source of truth for domain types, market
 * assumptions and every financial calculation in the platform.
 *
 * Consumed as TypeScript source by both the Vite client and the Node server,
 * so the "what-if" number a slider shows in the browser is computed by the same
 * code the agent calls server-side. There is no second implementation to drift.
 */
export * from './types.js';
export * from './assumptions.js';
export * from './format.js';
export * from './finance/math.js';
export * from './finance/portfolio.js';
export * from './finance/risk.js';
export * from './finance/goals.js';
export * from './finance/montecarlo.js';
export * from './finance/cashflow.js';
export * from './finance/actions.js';
export * from './finance/mutations.js';
export * from './finance/engine.js';
export * from './data/personas.js';
export * from './impact.js';
