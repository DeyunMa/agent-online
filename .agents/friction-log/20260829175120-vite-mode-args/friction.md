---
title: pnpm dev does not forward Vite mode arguments as expected
severity: minor
status: open
created: 2026-08-29
---

## Expected behavior

`pnpm dev -- --mode browser-smoke --host 127.0.0.1` should start Vite using the
`browser-smoke` mode so the local fake-runtime configuration is selected.

## Observed behavior

The command starts Vite in its default mode on port 5173. The command line
printed by pnpm contains an extra `--`, and the mode is not applied.

## Reproduction

Run `pnpm dev -- --mode browser-smoke --host 127.0.0.1` from the repository
root and inspect the reported local port and effective configuration.

## Impact and context

This can accidentally start the normal local environment while an agent
intends to use the isolated browser-smoke fake runtime. The safe workaround is
`pnpm exec vite --mode browser-smoke --host 127.0.0.1` with an explicit local
test `BETTER_AUTH_SECRET`.
