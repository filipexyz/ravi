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
- Delegated denials MUST identify the blocking branch when available: executor
  ceiling, actor, surface, or turn cap.
- Context capability counts are snapshots and MUST be labeled as such.
- The recommended fix MUST use provider-owned configuration, not removed command
  paths.
