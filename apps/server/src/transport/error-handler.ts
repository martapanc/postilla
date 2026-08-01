import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { isDomainError } from '../domain/errors/index.js';

/**
 * Maps every failure to RFC 9457 problem+json, so clients see one error shape
 * whether the request was malformed, rejected by a policy, or hit a bug.
 */

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  instance: string;
  errors?: { path: string; message: string }[];
  [key: string]: unknown;
}

const PROBLEM_BASE = 'https://postilla.dev/problems';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const instance = request.id;

    if (hasZodFastifySchemaValidationErrors(error)) {
      const problem: Problem = {
        type: `${PROBLEM_BASE}/validation-failed`,
        title: 'Request validation failed',
        status: 400,
        code: 'validation_failed',
        detail: 'The request did not match the expected schema.',
        instance,
        errors: error.validation.map((issue) => ({
          path: issue.instancePath.replace(/^\//, '').replaceAll('/', '.'),
          message: issue.message ?? 'invalid',
        })),
      };
      request.log.info({ problem }, 'request validation failed');
      return reply.status(400).type('application/problem+json').send(problem);
    }

    if (isDomainError(error)) {
      const problem: Problem = {
        type: `${PROBLEM_BASE}/${error.code.replaceAll('_', '-')}`,
        title: error.name,
        status: error.status,
        code: error.code,
        detail: error.message,
        instance,
        ...error.details,
      };
      request.log.info({ problem }, 'domain error');
      return reply.status(error.status).type('application/problem+json').send(problem);
    }

    // Fastify's own errors (rate limit, payload too large, bad JSON) carry a status.
    const fastifyError = error as Partial<FastifyError>;
    const status = fastifyError.statusCode ?? 500;
    if (status < 500) {
      const problem: Problem = {
        type: `${PROBLEM_BASE}/request-rejected`,
        title: 'Request rejected',
        status,
        code: fastifyError.code ?? 'request_rejected',
        detail: fastifyError.message ?? 'The request was rejected.',
        instance,
      };
      return reply.status(status).type('application/problem+json').send(problem);
    }

    // Unexpected. Log everything, tell the client nothing but the correlation id.
    request.log.error({ err: error }, 'unhandled error');
    const problem: Problem = {
      type: `${PROBLEM_BASE}/internal`,
      title: 'Internal Server Error',
      status: 500,
      code: 'internal_error',
      detail: 'An unexpected error occurred. Quote the instance id when reporting this.',
      instance,
    };
    return reply.status(500).type('application/problem+json').send(problem);
  });

  app.setNotFoundHandler((request, reply) => {
    const problem: Problem = {
      type: `${PROBLEM_BASE}/not-found`,
      title: 'Not Found',
      status: 404,
      code: 'not_found',
      detail: `Route ${request.method} ${request.url} does not exist.`,
      instance: request.id,
    };
    return reply.status(404).type('application/problem+json').send(problem);
  });
}
