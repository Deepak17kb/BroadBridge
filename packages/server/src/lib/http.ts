import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { logger } from './logger.js';

/** Errors thrown with this class become clean 4xx responses. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, message, details);

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}

/** Validates a request body against a Zod schema, raising a 400 with field detail. */
export function parseBody<T>(schema: ZodSchema<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest('Request body failed validation', flattenZod(result.error));
  }
  return result.data;
}

export function flattenZod(error: ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

export function errorMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    logger.warn('request rejected', { path: req.path, status: err.status, message: err.message });
    res.status(err.status).json({ error: err.message, details: err.details ?? null });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Validation failed', details: flattenZod(err) });
    return;
  }
  const message = err instanceof Error ? err.message : 'Unexpected error';
  logger.error('unhandled error', {
    path: req.path,
    message,
    stack: err instanceof Error ? err.stack : undefined,
  });
  // Never leak internals to the client; the stack is in CloudWatch.
  res.status(500).json({ error: 'Internal server error' });
}
