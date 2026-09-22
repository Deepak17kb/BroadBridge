/**
 * The error every API call rejects with, in its own module.
 *
 * Both clients throw it - the network one from a failed response, the static
 * one from a missing record - and `api.ts` picks between them, so the class
 * cannot live in either without making the import cycle.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
