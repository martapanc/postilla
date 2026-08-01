# 3. Drop the third-party OAuth proxy

**Status:** Accepted · **Date:** 2026-08-01

## Context

Waline's social login did not implement OAuth. It delegated the entire flow to
`https://oauth.lithub.cc` — a host operated by the upstream maintainer, outside
our control, with no security contact, audit, or SLA. That host receives the
authorization code and returns an identity assertion which the server then
trusts and maps onto a row in the users table.

## Decision

Delete the proxy and the `github`/`twitter`/`facebook`/`google`/`weibo`/`qq`
columns. Rebuild social login first-party with `arctic`, GitHub first, with the
callback on our own origin, storing identities in a `user_identities` table.

## Rationale

Whoever controls that host can mint an identity for any provider account. Since
identities map onto user rows and the first registered user is an
administrator, the blast radius plausibly includes authenticating as an admin.
For a single-author blog with one or two moderators, that is a large amount of
trust extended to a third party for a convenience feature.

The replacement is not much code: an authorization redirect, a callback that
exchanges the code, and a lookup keyed on `(provider, provider_user_id)`.

## Consequences

Each provider must be registered as an OAuth application and configured with
its own secret, so adding providers has a real per-provider cost. That cost is
the correct signal: GitHub is likely the only one worth carrying. Password plus
TOTP remains the primary path, so social login is never load-bearing.
