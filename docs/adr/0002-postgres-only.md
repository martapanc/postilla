# 2. One database, not nine

**Status:** Accepted · **Date:** 2026-08-01

## Context

Waline supported nine storage backends — LeanCloud, MySQL, PostgreSQL, SQLite,
TiDB, MongoDB, CloudBase, Deta, and a GitHub repository used as a database —
behind a hand-rolled query dialect borrowed from LeanCloud's API
(`['IN', [...]]`, `_complex: { _logic: 'or' }`, `objectId`).

That flexibility exists because Waline is a product serving strangers on free
tiers. This project has one deployment.

## Decision

PostgreSQL only, accessed through Drizzle. The repository _port interfaces_
survive in the domain layer; the eight other implementations do not.

## Rationale

The abstraction forced every query down to a lowest common denominator. The
clearest evidence: because LeanCloud has no `GROUP BY`, its adapter maintained
a hand-rolled denormalized counter table (`cache_group_count_user_id_mail`)
purely to fake one aggregate. The dialect also cost us transactions, foreign
keys, partial indexes, `ON CONFLICT`, CTEs, and full-text search — all of which
this application actually wants.

Keeping the port interfaces preserves the seam that matters (fake in-memory
repositories in unit tests, a second backend later if it is ever justified)
without paying for nine implementations that no one runs.

## Consequences

Self-hosting now requires Postgres rather than a file or a free-tier account.
`docker-compose.yml` ships with the project so that is a single command. If a
zero-dependency SQLite option is ever wanted, it is one implementation of a
sane interface rather than a new dialect for everyone to accommodate.
