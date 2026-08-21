---
id: cli/live-operational-help/runbook
title: "Live Operational Help Runbook"
kind: capability
domain: cli
status: draft
normative: false
---

## Diagnose Identity Drift

1. Run `ravi --help` and note agent, session, context and source labels.
2. Run `ravi self whoami --json` and `ravi self permissions --json`.
3. Run `ravi context whoami --json` and `ravi context capabilities --json`.
4. If a default credential is selected, all repeated registered facts must
   agree across the three surfaces.
5. Treat `legacy-environment` as orientation fallback only, never as proof of
   registry identity or capability.

## Diagnose Missing Capabilities

When no context record resolves, root help must say capabilities are
unavailable and point to context/SELF reads. An empty authoritative capability
set is valid only when a context record exists and its capability list is
actually empty.

## Validate

```bash
bun test src/runtime/runtime-operational-context.test.ts
bun test src/cli/context.test.ts
bun src/cli/index.ts --help
```
