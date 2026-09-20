---
title: MCP SDK 1.30 client transport conflicts with exactOptionalPropertyTypes
severity: minor
status: open
created: 2026-09-20
---

## Expected behavior

The official StreamableHTTPClientTransport implements the SDK Transport interface in a strict TS project.

## Observed behavior

With exactOptionalPropertyTypes, client.connect(transport) fails because the concrete sessionId
property is string | undefined whereas Transport declares sessionId?: string. Explicitly passing
sessionIdGenerator: undefined to the server transport also fails this project's typecheck.

## Reproduction

Use @modelcontextprotocol/sdk 1.30.0 with the current tsconfig and pass a newly constructed
StreamableHTTPClientTransport to Client.connect.

## Impact and context

The Workers integration test uses a narrow Transport assertion at the connection boundary, with
an explanatory comment. Production server options omit sessionIdGenerator for stateless operation.
Actual HTTP initialization and tool calls pass in the Workers runtime. No node_modules edits or
relaxation of project-wide TypeScript settings are necessary.
