---
id: cli/live-operational-help/checks
title: "Live Operational Help Checks"
kind: capability
domain: cli
status: draft
normative: false
---

- Root help MUST prefer the already resolved CLI context, including a valid
  default credential, over ambient legacy environment values.
- A direct `RAVI_CONTEXT_KEY` resolution MUST remain the final context fallback.
- Context resolution MUST remain read-only and MUST NOT touch `lastUsedAt`.
- Agent and session values MUST carry a source label.
- Context source and invocation source MUST remain separate facts.
- Without a resolved context, capabilities MUST be reported as unavailable;
  the renderer MUST NOT invent an authoritative empty set.
- Root help MUST NOT print context keys, credential values or secret env values.
- `runtime-operational-context.test.ts` MUST cover registry precedence, labeled
  fallback and honest capability degradation.
