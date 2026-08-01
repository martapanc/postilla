# 3. Drop social login entirely

**Status:** Accepted · **Date:** 2026-08-01
**Supersedes:** an earlier draft of this ADR that proposed rebuilding social
login first-party. Data from the LeanCloud export changed the decision.

## Context

Waline's social login did not implement OAuth. It delegated the entire flow to
`https://oauth.lithub.cc` — a host operated by the upstream maintainer, outside
our control, with no security contact, audit, or SLA. That host receives the
authorization code and returns an identity assertion which the server then
trusts and maps onto a row in the users table.

Whoever controls that host can mint an identity for any provider account.
Because the first registered user is an administrator, the blast radius
plausibly includes authenticating as one. Removing the proxy was never in
question.

The open question was what replaces it. The plan was to rebuild the flow
first-party with `arctic`, starting with GitHub.

## Decision

Remove social login and do not replace it. Authentication is password (argon2id)
plus TOTP. There is no `user_identities` table.

## Rationale

The LeanCloud export settled it. The database contains **one** user account,
and every social column on it — `github`, `twitter`, `facebook`, `google`,
`weibo`, `qq` — is empty. The feature has never been used. That account already
has TOTP enabled with a real 32-character secret, so the strong second factor
this would nominally add is already present.

Building an OAuth flow, registering provider applications, and carrying their
secrets would be solving a problem nobody has. A subsystem with no users is not
a showcase; it is maintenance and attack surface.

## Consequences

A future second moderator who wants social login needs the flow _and_ a schema
migration, rather than just the flow. That is the right trade at one user: the
migration is small, and deferring it means today's schema describes what the
system actually does.

If it is ever built, it must be first-party — callback on our own origin,
identities keyed on `(provider, provider_user_id)` — and never through a proxy.
