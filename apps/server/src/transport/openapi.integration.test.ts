import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { loadConfig } from '../config/env.js';
import { createContainerFrom } from '../container.js';
import { connectTestDatabase, type TestDatabase } from '../test-support/database.js';

/**
 * The OpenAPI document is generated from the zod schemas that validate real
 * requests, so it cannot describe an API the server does not implement.
 *
 * Snapshotting it turns any accidental change to the public contract — a
 * renamed field, a relaxed constraint, a route that quietly starts returning
 * something new — into a failing test rather than a client bug found later.
 * When a change is intentional, review the snapshot diff and update it.
 */

let harness: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  harness = connectTestDatabase();
  const config = loadConfig({
    DATABASE_URL: process.env['DATABASE_URL'],
    SERVER_URL: 'http://localhost:8360',
    SITE_NAME: 'Test',
    SECRET_KEY: 'a'.repeat(32),
    LOG_LEVEL: 'fatal',
  });
  app = await buildApp(createContainerFrom(config, harness.db, () => Promise.resolve()));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await harness.close();
});

describe('OpenAPI document', () => {
  it('matches the committed snapshot', () => {
    expect(app.swagger()).toMatchSnapshot();
  });

  it('documents every public route', () => {
    const paths = Object.keys(app.swagger().paths ?? {});

    expect(paths.sort()).toEqual([
      '/api/comments',
      '/api/comments/count',
      '/api/pages',
      '/api/pageviews',
      '/api/reactions',
      '/health',
      '/ready',
    ]);
  });

  it('never mentions a private field in any response schema', () => {
    // A structural guard rather than a per-route one: if a PII field ever
    // reaches the public contract, this fails wherever it was added.
    const document = JSON.stringify(app.swagger());

    for (const forbidden of [
      'authorEmail',
      'authorEmailHash',
      'authorIp',
      'userAgent',
      'passwordHash',
      'totpSecret',
    ]) {
      expect(document, `${forbidden} must not appear in the public API`).not.toContain(forbidden);
    }
  });
});
