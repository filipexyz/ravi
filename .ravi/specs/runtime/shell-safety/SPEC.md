---
id: runtime/shell-safety
title: "Shell Hard-Safety"
kind: capability
domain: runtime
capability: shell-safety
tags:
  - runtime
  - permissions
  - bash
  - safety
  - policy
applies_to:
  - src/bash
  - src/runtime/host-services.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Shell Hard-Safety

## Intent

Shell hard-safety is a policy layer that decides whether a shell command may run
at all, independent of who is asking or what they are authorized to do. It exists
to keep the promise that some shell constructs are never executed by an agent,
regardless of any grant.

Hard-safety answers a different question than Ravi capability authorization.
Authorization asks "is this subject allowed to run this executable?". Hard-safety
asks "is this command shape ever allowed to run?". The second question MUST be
answered first, and a "no" from hard-safety MUST NOT be overridable by any
authorization outcome.

## Boundary

Hard-safety owns:

- classification of dangerous command patterns;
- classification of unconditionally blocked executables in
  `UNCONDITIONAL_BLOCKS`;
- the stable `blockType` values and reason structure for those denials;
- the policy-only audit path for hard-safety denials.

Hard-safety does NOT own and MUST NOT change:

- environment spoofing detection (`RAVI_*` overrides);
- command parse-error handling;
- session scope enforcement;
- skill gates;
- the approval/cascading-approval flow;
- OS sandboxing;
- provider-native policy;
- external hooks or external ACLs;
- membership of `UNCONDITIONAL_BLOCKS`.

## Contract

- Shell hard-safety MUST be a policy layer evaluated before and independently of
  Ravi capability authorization.
- Dangerous patterns and every executable in `UNCONDITIONAL_BLOCKS` MUST deny
  under a specific grant, `execute executable:*`, `admin system:*`,
  `full-access`, and any future authorization bypass.
- The SDK Bash hook (`src/bash/hook.ts`) and the runtime host services
  (`src/runtime/host-services.ts`) MUST use the same classifier
  (`classifyShellHardSafety`), the same ordering, the same reason structure, and
  the same stable `blockType` values.
- Classification MUST be structured. Callers MUST derive the policy category from
  the returned `blockType`, never from free-form reason text.
- The classifier parses the command at most once. When it produces a valid parsed
  command, callers MUST reuse it instead of re-parsing.
- Dangerous patterns MUST use `blockType` `runtime_command_dangerous_pattern`.
- Unconditional executables MUST use `blockType`
  `runtime_executable_unconditional_block`.
- Ordering MUST be dangerous patterns first, then unconditional executables.
- A hard-safety denial MUST NOT materialize a missing capability, MUST NOT create
  a resolvable `permission_denials` row, and MUST NOT recommend a
  permission/profile/full-access grant as remediation.
- Safe commands MUST continue through the normal Permission Provider Runtime and
  MUST preserve existing wildcard/admin behavior.
- Hard-safety audit MUST include safe agent/context provenance and a stable
  category, and MUST NOT include a runtime context key, a raw secret environment
  value, a credential, or an unbounded command payload.
- Parse errors are not hard-safety denials. The classifier MUST report parse
  failure separately and leave existing parse-error handling unchanged.
- Future changes to the hard-block set or to hard-safety precedence MUST update
  these normative specs and the regression tests for both execution paths.

## Classification Shape

`classifyShellHardSafety(command)` returns a structured result:

```ts
interface ShellHardSafetyClassification {
  safe: boolean;
  blockType?:
    | "runtime_command_dangerous_pattern"
    | "runtime_executable_unconditional_block";
  reason?: string;
  executable?: string; // set for unconditional-executable blocks
  pattern?: string; // set for dangerous-pattern blocks
  parsed?: ParsedCommand; // present whenever parsing was attempted
  parseError?: string; // set on parse failure; not a hard-safety denial
}
```

A denial is present only when `safe === false` and `blockType` is set. Any other
result is a pass through to normal authorization (possibly carrying a
`parseError` the caller handles as it did before).

## Acceptance Criteria

- Every `UNCONDITIONAL_BLOCKS` member is denied in the SDK hook under a specific
  executable grant, a wildcard executable grant, and `admin system:*`.
- Every `UNCONDITIONAL_BLOCKS` member is denied in runtime host services under
  wildcard and admin contexts.
- Dangerous patterns deny under wildcard/admin in both paths with no capability
  early return before classification.
- `git status` and another safe command remain allowed under wildcard/admin.
- A specific `execute executable:bash` grant cannot allow `bash -c`.
- Both paths return the same stable `blockType` for the same command category.
- Hard-safety audit includes agent/context provenance, stays bounded and
  redacted, and creates no resolvable `permission_denials` row.
- Denial guidance never recommends a capability, profile, or full-access grant
  for a hard-safety policy denial.

## Validation

- `bun test src/bash/parser.test.ts src/bash/hook.test.ts`
- `bun test src/runtime/host-services.test.ts src/runtime/skill-gate.test.ts`
- `bun run typecheck`
