---
title: D1 remote migration rejects nested CASE inside triggers
severity: major
status: resolved
created: 2026-09-20
---

## Expected behavior

SQL accepted by the Workers D1 tests and local migration CLI also applies remotely.

## Observed behavior

Migration 0009 passed local D1 tests but remote `wrangler d1 migrations apply`
failed with `incomplete input: SQLITE_ERROR [code: 7500]`. Neither the schema
objects nor its migration ledger entry were committed.

## Reproduction

The original trigger body combined `SELECT CASE ... END;` and an UPSERT using
`CASE ... END,`. Wrangler 4.114.0's exported `unstable_splitSqlQuery` merged
multiple triggers because its END matcher did not accept a comma delimiter.
Adding whitespace before the comma repaired that local splitter, but remote
application still failed. Do not infer remote parsing from local success.

## Impact and context

The Preview release remained in maintenance while the migration was repaired.
Inspect schema objects and the migration ledger after failure before retrying;
never assume partial application or reset the remote database.

## Resolution

Use equivalent `SELECT RAISE(...) WHERE ...` and `iif(...)` expressions without
nested CASE/END. All 23 Workers D1 tests passed and remote migration 0009 applied
successfully. The new table, three triggers, and migration ledger were verified;
the nine release integrity checks also passed.
