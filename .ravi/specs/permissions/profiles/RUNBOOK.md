# Permission Profiles Runbook

## Inspect A Profile And Its Members

```bash
ravi permissions materialize --subject-type agent --subject-id <agent-id> --json
ravi agents permissions <agent-id>
```

Expected baseline:

- Materialized capabilities carry source metadata (provider, profile id,
  compartment, executor agent source).
- `full-access` materializes `admin system:*` with
  `agent-default-capabilities` provenance.

## Grant Recurring Authority

```bash
ravi permissions allow <profile> --to agent:<agent-id> \
  --capabilities <permission>:<objectType>:<objectId>
ravi permissions allow <profile> --to agent:<agent-id> \
  --capabilities <permission>:<objectType>:<objectId> --apply
```

- `allow`/`resolve` dry-run by default; `--apply` is required to mutate.
- Reuse an existing provider-owned permission tag when its capability set
  matches the denial.

## Diagnose A Hard-Safety Denial Under Full-Access

A `full-access` / `admin system:*` context is still denied dangerous patterns
and `UNCONDITIONAL_BLOCKS` executables by shell hard-safety
(`runtime/shell-safety`).

1. Read the audit `blockType`:
   - `runtime_command_dangerous_pattern` — command substitution, backticks,
     process substitution, here-docs, or piping into a shell/interpreter.
   - `runtime_executable_unconditional_block` — a member of
     `UNCONDITIONAL_BLOCKS` (e.g. `bash`, `sh`, `eval`, `exec`, `source`).
2. Do NOT recommend a broader profile or `full-access`; that never satisfies the
   policy. Rework the command to avoid the pattern/executable instead.
3. Changing the hard-block set or precedence requires updating the normative
   specs and regression tests for both execution paths.

## Regression Commands

```bash
bun test src/permissions/provider-runtime.test.ts src/permissions/delegation.test.ts
bun test src/bash/hook.test.ts src/runtime/host-services.test.ts
bun run typecheck
```
