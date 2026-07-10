---
id: runtime/shell-safety
title: "Shell Hard-Safety Runbook"
kind: runbook
domain: runtime
capability: shell-safety
owners:
  - ravi-dev
status: active
normative: true
---

# Runbook

## Diagnose a Suspected False Positive

A false positive is a *safe* command that hard-safety denied. Confirm it is
actually a hard-safety denial and not authorization, approval, scope, or a skill
gate before changing anything.

1. Reproduce the exact command string the agent submitted.
2. Inspect the classification:

   ```ts
   import { classifyShellHardSafety } from "./src/bash/index.js";
   classifyShellHardSafety("<command>");
   ```

   - `safe: true` → hard-safety did not deny. The denial came from another layer
     (authorization, approval, session scope, skill gate, env spoofing, parse
     error). Debug that layer instead.
   - `safe: false, blockType: "runtime_command_dangerous_pattern"` → a dangerous
     pattern matched. Check `reason`/`pattern`.
   - `safe: false, blockType: "runtime_executable_unconditional_block"` → the
     command resolved to an `UNCONDITIONAL_BLOCKS` member. Check `executable`.

## Inspect `blockType` From Audit

Hard-safety denials emit to the policy audit stream (`ravi.audit.denied`) with a
stable `blockType`:

- `runtime_command_dangerous_pattern`
- `runtime_executable_unconditional_block`

The audit event carries redacted agent/context provenance and a bounded command
preview. It does NOT carry a runtime context key, a raw secret env value, a
credential, or the full command line. There is intentionally no resolvable
`permission_denials` row for a hard-safety denial, and no grant is recommended.

If you see a hard-safety `blockType` in the audit but no matching
`permission_denials` row, that is correct behavior, not a missing write.

## Safe Policy-Change Procedure

Hard-safety is a security floor. Do not weaken it to unblock a workflow.

Prohibited quick fixes:

- adding an owner/privileged/profile bypass;
- moving the classifier after a capability check;
- inferring category from reason text instead of `blockType`;
- creating a new shell/eval/exec/source allowlist to route around the floor.

To change the hard-block set or precedence:

1. Update the normative contract in `runtime/shell-safety/SPEC.md` (and any
   dependent specs: `runtime/SPEC.md`, `runtime/providers`,
   `permissions/SPEC.md`, `permissions/profiles`).
2. Update `classifyShellHardSafety` in `src/bash/hard-safety.ts` so both paths
   change together. Never edit only one execution path.
3. Update regression tests for BOTH paths
   (`src/bash/parser.test.ts`, `src/bash/hook.test.ts`,
   `src/runtime/host-services.test.ts`), including specific-grant,
   wildcard-grant, and `admin system:*` coverage.
4. Run the CHECKS commands and `ravi specs sync --json`.

Membership of `UNCONDITIONAL_BLOCKS` itself is out of scope for routine changes
and requires an explicit, spec-backed decision.
