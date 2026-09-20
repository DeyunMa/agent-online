---
title: Better Auth CIMD transport and OpenAPI types need Workers-specific integration
severity: major
status: open
created: 2026-09-20
---

## Expected behavior

The official CIMD plugin should compose with Workers and strict TypeScript without
weakening network validation or endpoint inference.

## Observed behavior

The Node transport requires dns.lookup (not implemented in Workers). workerd also
rejects constructing a Request with redirect:error. OAuth Provider 1.7.5's authorize
OpenAPI parameter union is incompatible with better-call under exactOptionalPropertyTypes.

## Reproduction

Use the Node CIMD transport in Workers, or pass its redirect:error init into Request.
Add oauthProvider 1.7.5 to betterAuth plugins and run rtk proxy pnpm typecheck.

## Impact and context

Use an explicit trusted-host transport with redirect:manual plus rejection of 3xx,
never DNS precheck followed by unrestricted fetch. CIMD/D1 tests exercise real workerd.
The auth.ts assertion narrows only authorize OpenAPI documentation metadata and
preserves inferred endpoint signatures. Recheck this workaround on dependency upgrades.
