/**
 * A closed set of failures the application is allowed to express. Everything
 * else is a bug and surfaces as a 500 with a correlation id and no detail.
 *
 * Each error carries a stable machine `code`. Clients switch on the code and
 * render their own localized text — they never parse `message`, which is why
 * error text can be translated without touching the server.
 */

export type ErrorCode =
  | 'validation_failed'
  | 'not_found'
  | 'conflict'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'spam_rejected'
  | 'upstream_unavailable';

export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = Object.freeze({ ...details });
  }
}

export class ValidationError extends DomainError {
  readonly code = 'validation_failed' as const;
  readonly status = 422;
}

export class NotFoundError extends DomainError {
  readonly code = 'not_found' as const;
  readonly status = 404;

  constructor(resource: string, details: Record<string, unknown> = {}) {
    super(`${resource} not found`, { resource, ...details });
  }
}

export class ConflictError extends DomainError {
  readonly code = 'conflict' as const;
  readonly status = 409;
}

export class UnauthorizedError extends DomainError {
  readonly code = 'unauthorized' as const;
  readonly status = 401;
}

export class ForbiddenError extends DomainError {
  readonly code = 'forbidden' as const;
  readonly status = 403;
}

export class RateLimitedError extends DomainError {
  readonly code = 'rate_limited' as const;
  readonly status = 429;

  constructor(
    message: string,
    readonly retryAfterSeconds: number,
    details: Record<string, unknown> = {},
  ) {
    super(message, { retryAfterSeconds, ...details });
  }
}

export class SpamRejectedError extends DomainError {
  readonly code = 'spam_rejected' as const;
  readonly status = 422;
}

/** A third party we depend on (Akismet, Turnstile, a webhook) failed us. */
export class UpstreamError extends DomainError {
  readonly code = 'upstream_unavailable' as const;
  readonly status = 502;

  constructor(service: string, details: Record<string, unknown> = {}) {
    super(`Upstream service unavailable: ${service}`, { service, ...details });
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
