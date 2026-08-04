# 4. A transactional outbox, without a queue library

**Status:** Accepted · **Date:** 2026-08-01
**Deviates from:** the implementation plan, which specified pg-boss.

## Context

Notifications must not be lost, and must not take a comment down with them.
In the system this replaces, `notify()` was awaited inside the request: a
failing Discord webhook could fail the comment write, and a comment that
succeeded could silently drop its notification. Neither outcome was
observable.

The chosen pattern is a transactional outbox — the comment and its
notification row are written in one transaction, so either both exist or
neither does. The open question was what drains it.

The plan called for **pg-boss**, a job queue built on Postgres.

## Decision

Keep the outbox table and drain it with a small poller we own, using
`SELECT … FOR UPDATE SKIP LOCKED`. Do not add pg-boss.

## Rationale

pg-boss is a good library, but here it would sit _on top of_ the thing that
already provides the guarantee. The outbox row must be written in the comment's
transaction — that is the entire point — so pg-boss could not replace it, only
follow it. We would end up with the outbox table **and** pg-boss's own tables,
each message stored twice, and a second thing to reason about when a
notification goes missing.

What pg-boss would actually contribute is retry scheduling and concurrency
control. Both are a few lines here: `available_at` plus an attempt counter
gives exponential backoff, and `FOR UPDATE SKIP LOCKED` — the same primitive
pg-boss uses — lets several workers share the table safely.

## Consequences

We own the scheduling logic, so it is ours to test: retry, backoff, the
attempt ceiling, and concurrent draining each have an integration test against
a real Postgres.

We give up the features a mature queue offers — cron scheduling, priorities,
job dependencies, a dashboard. None are needed to send a message when a comment
is posted. If a genuine job queue is ever wanted, the outbox stays as it is and
becomes its producer, which is exactly where a queue belongs.

The worker runs in the API process. That is deliberate and consistent with
[ADR 0001](0001-fastify-over-hono.md): needing something always present to
drain the outbox is a principal reason this targets a long-lived container
rather than serverless. `OUTBOX_WORKER_ENABLED=false` allows running it as a
separate process later without a code change.
