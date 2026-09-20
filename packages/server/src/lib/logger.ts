import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

/**
 * Structured JSON logging with no dependency. CloudWatch parses JSON lines into
 * queryable fields, which is all we need from a logger here - and one fewer
 * package in the Lambda bundle.
 */
function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[config.logLevel]) return;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    message,
    ...meta,
  });
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => emit('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit('error', message, meta),
};

/** Truncates a value for safe logging - profiles are large and often noisy. */
export function brief(value: unknown, max = 300): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
