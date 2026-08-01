# 1. Fastify over Hono

**Status:** Accepted · **Date:** 2026-08-01

## Context

The replacement server needs a Node HTTP framework. Hono is the portable
option — it runs on Workers, Deno, and Bun as well as Node — and Fastify is the
Node-native one with a mature plugin ecosystem.

## Decision

Use Fastify 5, confined to `apps/server/src/transport/`.

## Rationale

1. **A long-lived process is required regardless.** The notification outbox
   worker polls and retries, rate limiting is in-process, and the Postgres pool
   wants to stay warm. That is Fastify's home turf, and it negates Hono's main
   advantage.
2. **Native dependencies are load-bearing.** DOMPurify + jsdom for comment
   sanitization, argon2 for password hashing, and nodemailer for email do not
   run on Workers. Hono's portability is unrealizable here without rewriting
   the sanitizer.
3. **Response schemas prevent PII leaks.** `fast-json-stringify` serializes
   from the declared response schema, so a field that is not in the schema
   cannot be returned. For a system storing emails and IP addresses this is a
   safety property, not a performance tweak. The old server hand-built response
   objects and relied on remembering to strip fields.
4. **`app.inject()`** runs the full request lifecycle with no socket, which is
   what makes the API contract tests fast enough to run on every commit.

## Consequences

We give up edge portability. To keep the cost of that reversible, the transport
layer stays thin and a lint rule forbids importing `fastify` anywhere outside
it — porting to Hono would be a contained rewrite of one directory rather than
a rewrite of the application.
