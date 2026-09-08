---
title: shadcn Base Tabs generated selectors do not match installed Base UI attributes
severity: major
status: open
created: 2026-09-08
---

## Expected behavior

Generated Base Tabs should arrange horizontal tabs above their panel and match the installed
Base UI data attributes without additional application CSS.

## Observed behavior

shadcn 4.21.0 generated `data-horizontal:flex-col` and
`group-data-horizontal/tabs` / `group-data-vertical/tabs` variants. Base UI 1.7.0 declares
`data-orientation="horizontal"` / `"vertical"` instead. TypeScript and Biome accept both
forms, so these checks do not catch the ineffective selectors.

## Reproduction

Inspect the generated Tabs classes from the `base-nova` style and compare them with
`node_modules/@base-ui/react/tabs/root/TabsRootDataAttributes.d.ts`. Render horizontal Tabs
without an application flex-direction override, then inspect its computed layout.

## Impact and context

The library adoption browser smoke exposed broken conversation layout despite passing static
checks. Use explicit `data-[orientation=horizontal]` and matching group variants for this
installed version, and verify actual browser layout after regeneration. Do not assume fresh
registry output is compatible solely because it typechecks. This entry tracks the generator
compatibility issue; repository components are corrected within the current task.
