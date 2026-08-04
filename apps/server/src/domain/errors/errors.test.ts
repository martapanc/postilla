import { describe, expect, it } from 'vitest';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  SpamRejectedError,
  UnauthorizedError,
  UpstreamError,
  ValidationError,
  isDomainError,
} from './index.js';

/**
 * The `code` on each error is a public contract: clients switch on it and
 * render their own localized text. Renaming one silently breaks every client,
 * so the codes are pinned here.
 */

describe('error codes and statuses are stable', () => {
  it.each([
    [new ValidationError('x'), 'validation_failed', 422],
    [new NotFoundError('Comment'), 'not_found', 404],
    [new ConflictError('x'), 'conflict', 409],
    [new UnauthorizedError('x'), 'unauthorized', 401],
    [new ForbiddenError('x'), 'forbidden', 403],
    [new RateLimitedError('x', 30), 'rate_limited', 429],
    [new SpamRejectedError('x'), 'spam_rejected', 422],
    [new UpstreamError('akismet'), 'upstream_unavailable', 502],
  ])('$name maps to %s / %i', (error, code, status) => {
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
  });
});

describe('DomainError', () => {
  it('carries structured details', () => {
    const error = new ValidationError('too long', { max: 100, field: 'comment' });

    expect(error.details).toEqual({ max: 100, field: 'comment' });
  });

  it('freezes details so a handler cannot mutate them', () => {
    const error = new ValidationError('x', { a: 1 });

    expect(Object.isFrozen(error.details)).toBe(true);
  });

  it('copies details rather than aliasing the caller’s object', () => {
    const details = { a: 1 };
    const error = new ValidationError('x', details);
    details.a = 2;

    expect(error.details['a']).toBe(1);
  });

  it('defaults details to an empty object', () => {
    expect(new ConflictError('x').details).toEqual({});
  });

  it('sets name to the concrete subclass, for logs', () => {
    expect(new NotFoundError('Comment').name).toBe('NotFoundError');
    expect(new RateLimitedError('x', 1).name).toBe('RateLimitedError');
  });

  it('is a real Error, so stack traces and instanceof work', () => {
    const error = new ValidationError('x');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.stack).toBeDefined();
  });
});

describe('specific errors', () => {
  it('NotFoundError names the resource in the message and details', () => {
    const error = new NotFoundError('Parent comment', { id: 'abc' });

    expect(error.message).toBe('Parent comment not found');
    expect(error.details).toMatchObject({ resource: 'Parent comment', id: 'abc' });
  });

  it('RateLimitedError exposes retryAfterSeconds both ways', () => {
    const error = new RateLimitedError('slow down', 42);

    expect(error.retryAfterSeconds).toBe(42);
    // Also in details, so the problem+json body carries it without a special case.
    expect(error.details['retryAfterSeconds']).toBe(42);
  });

  it('UpstreamError names the failing service', () => {
    const error = new UpstreamError('akismet');

    expect(error.message).toContain('akismet');
    expect(error.details['service']).toBe('akismet');
  });
});

describe('isDomainError', () => {
  it('recognizes every domain error', () => {
    expect(isDomainError(new ValidationError('x'))).toBe(true);
    expect(isDomainError(new UpstreamError('s'))).toBe(true);
  });

  it('rejects anything else, so unexpected failures become a 500', () => {
    expect(isDomainError(new Error('boom'))).toBe(false);
    expect(isDomainError(new TypeError('boom'))).toBe(false);
    expect(isDomainError('a string')).toBe(false);
    expect(isDomainError(null)).toBe(false);
    expect(isDomainError({ code: 'not_found', status: 404 })).toBe(false);
  });
});
