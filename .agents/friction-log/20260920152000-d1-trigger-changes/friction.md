---
title: D1 meta.changes includes admission trigger writes
severity: major
status: resolved
created: 2026-09-20
---

## Expected behavior

A successful single-row Terminal or model admission is recognized as admitted.

## Observed behavior

After adding counter-writing triggers, `meta.changes === 1` rejected successful
admissions. The target row was written together with the counter row.

## Reproduction

Run `rtk pnpm test:d1`. The resource admission suite exercises Terminal insertion
and model-request updates with the real migration triggers. Before switching to
RETURNING, five of six new cases failed despite successful underlying mutations.

## Impact and context

Do not infer a target-row mutation count from D1 aggregate execution metadata when
the statement also invokes writing triggers. Fake D1 fixtures that always return
`changes: 1` do not expose this behavior.

## Resolution

Terminal claim and model admission now use `RETURNING id` to identify the affected
target row. The Terminal unit fixture also reports two changes. All 23 real D1
tests passed after the correction, including concurrent admission and rollback.
