# Postilla

A self-hosted comment system for static blogs: an embeddable Vue widget, a
moderation dashboard, and a Fastify + PostgreSQL API.

Postilla began as a fork of [Waline](https://github.com/walinejs/waline) and is
being rewritten from the ground up. Waline's design informed the feature set;
none of its code is carried forward.

> **Status: in development.** The API reads and writes comments against real
> migrated data; the frontends are not built yet. See the milestone table below.

## Why a rewrite

Two things forced it. LeanCloud — the original default datastore — shuts down at
the end of 2026, so the data has to move regardless. And the inherited codebase
had structural problems that were cheaper to replace than to repair: ThinkJS 4
_alpha_ with an ambient `think.*` global and a service locator that made unit
testing effectively impossible, nine storage backends behind a hand-rolled
query dialect, and an i18n system built on positional arrays where adding one
string meant editing twelve files at the same index.

## Architecture

Dependencies point inward. The domain layer is pure TypeScript with no IO, no
framework, and no persistence — which is what makes it testable without a
database or an HTTP server.

```
transport/       Fastify routes, auth hooks, error mapping, OpenAPI. Knows HTTP, not SQL.
application/     Use cases. Orchestrate, transact, emit events.
domain/          Entities, value objects, policies. Pure.
ports/           Interfaces the domain depends on.
infrastructure/  Drizzle repositories, notification channels, spam checks, markdown.
```

These boundaries are enforced by lint rules rather than by convention — see
`eslint.config.mjs`. A violation is a design error, not a lint nit to silence:

- Only `transport/` may import Fastify.
- Only `config/env.ts` may read `process.env`.
- `domain/` may not import `node:*`, Drizzle, Fastify, or any outer layer.

### Layout

```
apps/server      Fastify API. The only thing that talks to Postgres.
apps/admin       Vue 3 moderation dashboard (served same-origin by the API).
packages/contract  zod schemas → types, typed client, and OpenAPI, from one declaration.
packages/i18n      ICU message catalogs (en, it), shared by server and frontends.
packages/embed     The embeddable Vue 3 widget. The only published artifact.
tools/migrate-leancloud  One-shot migration CLI.
```

## Getting started

Requires Node 24+, pnpm 10+, and Docker.

```bash
pnpm install
cp .env.example .env
docker compose up -d          # Postgres on :5432, Mailpit on :8025
pnpm db:migrate
pnpm dev                      # http://localhost:8360
```

Verify:

```bash
curl localhost:8360/health    # liveness — never touches the database
curl localhost:8360/ready     # readiness — database + migration count
```

### Commands

| Command                        | Purpose                                           |
| ------------------------------ | ------------------------------------------------- |
| `pnpm dev`                     | Run the API with reload                           |
| `pnpm lint` / `pnpm typecheck` | Static checks, including boundary rules           |
| `pnpm test:unit`               | Fast, pure, no IO                                 |
| `pnpm test:integration`        | Against a real Postgres                           |
| `pnpm test:coverage`           | Both suites, with thresholds enforced             |
| `pnpm db:backfill-html`        | Render `body_html` for migrated comments          |
| `pnpm db:generate`             | Generate a migration from schema changes          |
| `pnpm db:migrate`              | Apply migrations (advisory-locked, never at boot) |
| `pnpm db:drift`                | Fail if the schema has uncommitted migrations     |

## Deployment

Targets a long-lived container — Fly.io is the reference deployment, one region,
`min_machines_running = 1`. Serverless was considered and rejected for v1: the
notification outbox needs a background worker, the sanitizer and password
hashing need native modules, and cold starts are especially costly for a widget
that loads on every page of a blog. Because the transport layer is thin, that
decision is revisitable without touching the application.

`docker-compose.yml` covers local development and the integration tests, so
what we test against is what we develop against. It is **not** a production
configuration — its database trusts every connection and is bound to loopback.
A deployment needs a real password, TLS, and backups.

## Decisions

Architecture decision records live in [`docs/adr`](docs/adr). Start with
[Fastify over Hono](docs/adr/0001-fastify-over-hono.md),
[one database not nine](docs/adr/0002-postgres-only.md), and
[dropping social login](docs/adr/0003-drop-the-oauth-proxy.md), and
[an outbox without a queue library](docs/adr/0004-outbox-without-a-queue-library.md).

## Roadmap

|        | Milestone                                                                | Status |
| ------ | ------------------------------------------------------------------------ | ------ |
| M0     | Skeleton: config, schema, migrations, health, error model, CI            | ✅     |
| M1     | LeanCloud migration tool (export → transform → load → verify)            | ✅     |
| M2     | Read path: pages, threaded comments, reactions, pageviews                | ✅     |
| M3     | Write path: markdown, sanitization, spam, rate limits, moderation policy | ✅     |
| M4     | Notifications: channels, locale-driven templates, outbox worker          | ✅     |
| M5     | Auth: sessions, argon2id, TOTP                                           | Next   |
| M6     | Admin dashboard (Vue 3)                                                  |        |
| M7     | Embed widget (Vue 3)                                                     |        |
| M8–M10 | Staging, cutover, decommission                                           |        |

M1 came before any feature work on purpose: it was the deadline-bound piece, and
building it first forced the schema to be real before anything depended on it.

## License

MIT
