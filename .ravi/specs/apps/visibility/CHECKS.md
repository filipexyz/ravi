---
id: apps/visibility/checks
title: "App Visibility Checks"
kind: checks
domain: apps
capability: visibility
---

# App Visibility Checks

## Regression Tests

- `apps list` filters manifests through app visibility under runtime context.
- `apps show` hides a manifest without `use app:<id>`.
- `apps check <id>` hides manifest path/errors without `use app:<id>`.
- `apps check --all` skips hidden apps under runtime context.
- `maybeRunAppAliasRoute` returns `false` for hidden app ids.
- Router builtin `help/show/check` fail without `use app:<id>`.
- Mutating operations fail without `execute app:<id>`.

## Manual Checks

```bash
ravi specs get apps/visibility --mode rules --json
```
