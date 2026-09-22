import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

/**
 * Structured JSON logging with no dependency. A log aggregator parses JSON
 * lines into queryable fields, which is all we need from a logger here - and
 * one fewer package in the bundle.
 *
 * The streams are resolved per call rather than captured once, because this
 * module is also loaded in the browser: the agent runs client-side on the
 * static build, where `process` does not exist and `console` is the only
 * sink there is.
 */
function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[config.logLevel]) return;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    message,
    ...meta,
  });
  const stream =
    typeof process !== 'undefined' && process.stdout
      ? level === 'error' || level === 'warn'
        ? process.stderr
        : process.stdout
      : null;
  if (stream) stream.write(`${line}\n`);
  else if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
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
