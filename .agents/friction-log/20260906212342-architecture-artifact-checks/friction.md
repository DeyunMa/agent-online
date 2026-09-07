---
title: Architecture visualization artifacts block the repository validation gate
severity: major
status: resolved
created: 2026-09-06
---

## Expected behavior

The committed architecture visualization should coexist with the repository's
Biome configuration and allow `rtk pnpm check` to execute all validation stages.

## Observed behavior

`rtk pnpm check` stops at lint with 199 errors, 743 warnings, and 2 infos;
reported diagnostics include the architecture HTML's ARIA and SVG markup.
Separately, `rtk pnpm format:check` reports one formatting error in
`docs/architecture/agent-online-system.architecture.json`.

## Reproduction

From the repository root, run `rtk pnpm check`, then independently run
`rtk pnpm format:check`. Neither command modifies source files.

## Impact and context

CI invokes the same sequential check command, so these failures prevent later
type, test, build, and browser checks from running through the combined gate.
During the audit, running typecheck, test, build, and test:browser separately
passed (269 unit tests, 7 D1 tests, 6 browser tests; paid E2E remained skipped).
This is a diagnostic workaround, not a passing aggregate gate. Align generated
HTML handling with explicit scoped checks and format the canonical JSON; do
not disable source-wide lint rules to hide generated-artifact diagnostics.

## Resolution

2026-09-06: Added an exact-file Biome linter override for the Archify-generated
HTML runtime and formatted the architecture JSON source. Business source rules
remain enabled; the HTML remains covered by repository secret scanning. The
generated-artifact convention is documented in `docs/reference/current-architecture.md`.
`rtk pnpm check` now passes end to end: 303 unit tests, 8 D1 tests, 8 browser
tests, typecheck, lint, format, import boundaries, secret scans, and build.
The paid E2B/Gemini test remains explicitly skipped.
