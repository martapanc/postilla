import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config/env.js';
import type { Container } from '../../container.js';

/**
 * Uses `app.inject()`, so the whole request lifecycle runs — routing,
 * validation, serialization, error handling — with no socket and no database.
 * The container is a stub: that is the point of having a composition root.
 */

const config = loadConfig({
  DATABASE_URL: 'postgres://postilla@localhost:5432/postilla',
  SERVER_URL: 'http://localhost:8360',
  SITE_NAME: 'Test Site',
  SECRET_KEY: 'a'.repeat(32),
  LOG_LEVEL: 'fatal',
});

function containerWithDb(execute: () => Promise<unknown>): Container {
  return {
    config,
    db: { execute } as unknown as Container['db'],
    shutdown: () => Promise.resolve(),
  };
}

describe('GET /health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Deliberately given a database that always fails, to prove liveness
    // never depends on it — otherwise a database blip gets a healthy process killed.
    app = await buildApp(containerWithDb(() => Promise.reject(new Error('db is down'))));
  });
  afterAll(async () => await app.close());

  it('reports ok without touching the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
    expect(response.json<{ uptimeSeconds: number }>().uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /ready', () => {
  it('reports ready when the database and migrations both answer', async () => {
    const app = await buildApp(containerWithDb(() => Promise.resolve({ rows: [{ count: '3' }] })));

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ready',
      checks: { database: { ok: true }, migrations: { ok: true, applied: 3 } },
    });
    await app.close();
  });

  it('reports 503 and degraded when the database is unreachable', async () => {
    const app = await buildApp(containerWithDb(() => Promise.reject(new Error('db is down'))));

    const response = await app.inject({ method: 'GET', url: '/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      checks: { database: { ok: false, error: 'db is down' } },
    });
    await app.close();
  });
});

describe('error handling', () => {
  it('renders unknown routes as RFC 9457 problem+json', async () => {
    const app = await buildApp(containerWithDb(() => Promise.resolve({ rows: [] })));

    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      code: 'not_found',
      status: 404,
      title: 'Not Found',
    });
    // Clients switch on `code`; `instance` is what makes a report traceable.
    expect(response.json<{ instance: string }>().instance).toBeTruthy();
    await app.close();
  });
});
