---
title: DCG can misclassify JavaScript inside ego-browser heredocs as shell syntax
severity: minor
status: open
created: 2026-09-07
---

## Expected behavior

The approved `rtk proxy ego-browser nodejs` heredoc executes JavaScript browser helpers,
without interpreting their expressions as shell redirections or process substitution.

## Observed behavior

During release verification, DCG rejected several mixed UI/evaluation heredocs with
`core.filesystem:redirect-truncate-dynamic-path` or
`heredoc.posix:process-substitution`. No shell redirection or process substitution was intended.

## Reproduction

Use a quoted EOF heredoc with ego `click`/`wait` helpers followed by `js()` containing
an async arrow IIFE and an object-returning `map` arrow. The failed cases included
`map(x=>({id:x.id,status:x.status}))` and a DOM input enumeration. The exact guard
classification depends on surrounding JavaScript; this is an observed pattern, not a
claim that every arrow function is rejected.

## Impact and context

Several readback rounds were blocked before execution during the release E2E. A working
approach was to keep UI actions in one heredoc and use explicit function syntax inside a
separate browser evaluation IIFE. Do not disable or allowlist the guard to work around this.
Always verify the page after a rejected round before continuing; blocked actions did not run.
