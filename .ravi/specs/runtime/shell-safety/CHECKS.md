---
id: runtime/shell-safety
title: "Shell Hard-Safety Checks"
kind: checks
domain: runtime
capability: shell-safety
owners:
  - ravi-dev
status: active
normative: true
---

# Checks

## Classifier (`src/bash/parser.test.ts`)

- `classifyShellHardSafety` returns safe with parsed data for a safe command and
  parses once.
- Dangerous patterns classify as `runtime_command_dangerous_pattern`.
- Every `UNCONDITIONAL_BLOCKS` member classifies as
  `runtime_executable_unconditional_block` with the offending executable.
- Dangerous patterns are ordered before unconditional executables.
- Parse failures are surfaced as `parseError` and are not a hard-safety block.
- An unconditional block is detected anywhere in a command chain.

## SDK Bash hook (`src/bash/hook.test.ts`)

- Every `UNCONDITIONAL_BLOCKS` member is denied under a specific executable
  grant, a wildcard executable grant, and `admin system:*`.
- A specific `execute executable:bash` grant cannot allow `bash -c`.
- Dangerous patterns deny under wildcard and admin grants.
- `git status` and another safe command remain allowed under wildcard/admin.
- A hard-safety block does not create a resolvable `permission_denials` row.
- The decision reports `denialType: "hard_safety"` and the stable `blockType`.

## Runtime host services (`src/runtime/host-services.test.ts`)

- Every `UNCONDITIONAL_BLOCKS` member is denied under wildcard executable and
  `admin system:*` contexts.
- Dangerous patterns deny under wildcard/admin with the stable `blockType`.
- `git status` and another safe command remain approved under wildcard/admin.
- The hard-safety audit carries agent/context provenance, stays bounded, does
  not leak the runtime context key, and creates no resolvable
  `permission_denials` row.

## Commands

```bash
bun test src/bash/parser.test.ts src/bash/hook.test.ts
bun test src/runtime/host-services.test.ts src/runtime/skill-gate.test.ts
bun test src/permissions/provider-runtime.test.ts src/permissions/audit-provenance.test.ts src/events/audit-stream.test.ts
bun run typecheck
bun run build:cli
bun run build
ravi specs sync --json
ravi specs get runtime/shell-safety --mode full --json
ravi specs get runtime/shell-safety --mode checks --json
ravi sdk returns validate --strict --json
git diff --check
```
