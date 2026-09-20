---
title: Better Auth 1.7.5 refresh rotation can survive concurrent revocation
severity: major
status: open
created: 2026-09-20
---

## Expected behavior

Revocation must prevent an in-flight refresh from creating a usable successor.

## Observed behavior

The OAuth Provider performs rotation CAS and successor INSERT as separate adapter
operations. Revocation can delete the family between them; the late INSERT succeeds
and its new refresh token can renew again. Both the application's connection revoke
and the upstream `/oauth2/revoke` family invalidation reproduce this on real local D1.
The upstream endpoint returns 400 for the already-rotated token but deletes the family;
that deletion still cannot prevent the pending successor INSERT.

## Reproduction

`rtk proxy pnpm test:d1 src/server/mcp/mcp.cloudflare.test.ts`

The two explicitly marked `it.fails` cases pause the real Better Auth adapter before
the successor INSERT, revoke and verify no remaining family rows, then resume and
attempt another refresh. Temporarily removing `.fails` produces exactly two failures
at the final assertion: expected HTTP 400, received 200. No sleeps, remote writes,
or dependency modifications are needed.

## Impact and context

Confirmed with installed `@better-auth/oauth-provider` 1.7.5; npm latest was also
1.7.5 on the verification date. This is not the documented five-minute access-token
TTL: a surviving refresh token can continue renewal. Kept open under the user's
explicit upstream-defect exception. No node_modules patch or speculative auth
replacement was added, and no upstream report was sent. Upgrade only after rerunning
the regression without `.fails`; also verify pending authorization-code revocation.
