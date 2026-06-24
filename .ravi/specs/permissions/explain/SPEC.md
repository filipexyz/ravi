---
id: permissions/explain
title: "Permission Explainability"
kind: capability
domain: permissions
capability: explain
capabilities:
  - provider-runtime
  - delegation
  - audit
  - denials
  - provenance
tags:
  - permissions
  - explainability
  - audit
  - operations
applies_to:
  - src/permissions/provider-runtime.ts
  - src/permissions/denials.ts
  - src/permissions/delegation.ts
  - src/cli/commands/permissions.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Permission Explainability

Permission explanation MUST be derived from provider-runtime decisions and
stored denial/audit metadata. It MUST NOT reconstruct a separate authorization
engine.

Current supported operator surface:

```bash
ravi permissions status --json
ravi permissions check --permission <perm> --object-type <type> --object-id <id> --json
ravi permissions materialize --subject-type <type> --subject-id <id> --json
```

Rules:

- Explainability data MUST preserve provider id, reason code, canonical action,
  canonical object, and safe evidence.
- Agent-identity denials MUST identify whether the block came from missing
  executor/agent-identity capability, unresolved actor, turn cap, or provider
  runtime failure. Historical delegated denial records MAY still identify
  actor/surface branches, but runtime context creation MUST NOT emit new legacy
  delegated authority contexts.
- Context capability counts are snapshots and MUST be labeled as such.
- The recommended fix MUST use provider-owned configuration, not removed command
  paths.
- The recommended fix SHOULD name an existing provider-owned permission
  profile/tag when one matches the missing capability. If no profile is known,
  explain MAY show the raw canonical capability as bootstrap material for a new
  narrow profile.
- Explain output SHOULD reuse the shared authorization guidance envelope used
  by CLI denials and approval prompts. It MUST NOT maintain a second,
  incompatible recommendation format.
- Explain output MUST label `full-access` as break-glass and MUST NOT recommend
  it as the first fix for ordinary denials.
