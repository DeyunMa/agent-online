# AGENTS.md

## Purpose

Agent Online is a personal, development-stage Coding Agent SaaS project. It is a single Cloudflare Worker product: React provides the browser UI, Hono owns the control plane, and Agent processes run only inside a sandbox.

## First Checks

- Before changing code, inspect the relevant source and check `git status --short`.
- Read `README.md`, `CONTEXT.md`, and the relevant file under `docs/architecture/` before changing domain, storage, runtime, or deployment boundaries.
- Prefer `rg` and `rg --files` for discovery. Keep documents, migrations, contracts, and tests aligned when changing a cross-layer contract.

## Architecture Boundaries

- Preserve `User -> Project -> SandboxLease` ownership. Each Project has one logical SandboxLease record and at most one active provider sandbox. Browsers never receive provider sandbox IDs, internal ports, provider credentials, or raw model keys.
- Keep one deployable Worker. Do not split frontend/backend or turn `AgentRuntime` into a separate service without an explicit architecture decision.
- `src/client/` must not import `src/server/`; `src/domain/` stays framework/provider independent; `src/agent/` depends only on generic `SandboxRuntime` contracts, not provider SDKs.
- `SandboxRuntime` owns sandbox lifecycle and generic process/file capabilities. Terminal, Preview, and Changes are separate narrow runtime capabilities. Application modules should depend only on the capability they use. `AgentRuntime` owns an individual Agent protocol and normalized events. Do not merge those responsibilities.
- Pi is the default and currently validated AgentRuntime. Additional runtimes require an accepted ADR, a dedicated adapter, an explicit server allowlist or feature flag, ModelGateway compatibility, cancellation/final-output/usage tests, and a real end-to-end validation before UI exposure. Goose follows ADR-0004 and is executable only under `GOOSE_RUNTIME_MODE`; `spike` may accept an explicit authenticated API request but must remain absent from public capabilities and UI. Reserved IDs alone never imply support.
- Platform model access must go through a Worker-side gateway. Never inject raw Gemini keys into a sandbox, browser response, log, or persisted data. BYOK is deferred until a separate decision.
- V1 stores product state in D1: authentication, Project metadata, user-visible messages, `AgentRun` lifecycle, per-run aggregate usage, and only the current ephemeral Terminal/Preview coordination records. Never persist Terminal input/output, Preview content/history, or Git status/diff/history. Changes is a bounded read of the current sandbox working tree/index and cannot be attributed to one Run; it must reject extra repository config scopes and explicitly mark unsupported paths instead of reporting clean. The sandbox filesystem is the only workspace copy; a stopped or expired sandbox may lose its files.
- `AgentRun` is one short-lived Agent execution, normally one user turn. A Project has at most one non-terminal AgentRun or one Terminal hard lock, and those activities are mutually exclusive; wall-clock expiry alone never unlocks a Terminal. Preview startup also requires both to be absent, but a running Preview may coexist with a later Run or Terminal and must block whole-sandbox stop/idle cleanup. Do not reintroduce durable Agent sessions, reconnectable Terminals, arbitrary preview commands/ports, workspace revision history, or raw transcript retention without a new ADR.

## Development Data Policy

- This is a personal development project. Backward compatibility with previous local code, local D1 data, obsolete R2 scaffolding, or test fixtures is not a goal.
- When a schema, storage boundary, or ownership model needs to change, prefer the clean current design. It is acceptable to replace migrations, reset local development data, and remove obsolete code paths instead of adding compatibility adapters, dual readers, backfills, or legacy feature flags.
- State the reset scope in commentary, update the canonical schema, fixtures, tests, and docs together, and leave a reproducible local reset path.
- This policy applies only to known local/development data. Never delete remote Cloudflare resources, unknown data, Git history, or deployed data without explicit user approval.

## Code Map

| Path | Responsibility |
| --- | --- |
| `src/client/` | React UI and browser data access. |
| `src/server/` | Hono routes, Better Auth, configuration, and trusted HTTP boundaries. |
| `src/domain/` | Provider-independent Project and SandboxLease rules. |
| `src/application/` | Use-case ports and orchestration contracts, including `RunCoordinator`. |
| `src/runtime/` | SandboxRuntime contract and provider adapters. |
| `src/agent/` | AgentRuntime contract, registry, and Agent adapters. |
| `migrations/` | Canonical D1 schema for auth and application data. |
| `docs/architecture/` | Stable architecture decisions and contracts. |
| `worker/` | Cloudflare Worker entrypoint. |

## Generated and Local Files

- Do not manually edit `worker-configuration.d.ts`; regenerate it with `pnpm cf-typegen` after binding changes.
- Do not commit `.dev.vars`, `.env*` (except examples), `.wrangler/`, `.serena/`, build output, dependency directories, or local browser/test state.
- Never print, commit, or copy secret values. Refer only to environment variable names such as `GEMINI_API_KEY`, `BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL`.

## Validation

| Change | Required validation |
| --- | --- |
| Narrow domain/runtime change | Relevant unit tests and `pnpm typecheck`. |
| API, schema, or auth change | Relevant tests, `pnpm typecheck`, and a local D1 migration check. |
| Shared contract or release-facing change | `pnpm check` (import boundaries, typecheck, tests, and build). |

Useful commands:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm check:boundaries
pnpm check
pnpm wrangler d1 migrations apply DB --local
pnpm cf-typegen
```

## Safety and Git

- Keep changes scoped and do not revert unrelated user work.
- Remote resource creation, remote D1 writes or deletion, sandbox-provider changes, secret changes, and `wrangler deploy` require explicit user approval.
- Do not create commits, push, force-push, reset, or rewrite history unless the user explicitly asks.
- Report validation results and any remaining risk in the final response.
