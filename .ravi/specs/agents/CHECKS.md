# Agents Checks

## Visibility Checks

- `agents list --json` under runtime context MUST include the current agent and
  agents covered by `view agent:<id>`, and MUST exclude others.
- `agents show <hidden-agent> --json` MUST NOT reveal hidden agent configuration.
- Agent route inspection MUST NOT disclose hidden agent config to a principal
  that lacks `view agent:<id>`.
- A superadmin executor invoked by an untrusted contact MUST NOT expose hidden
  agents solely because the executor has broad grants.

## Model Preset Checks

- Assigning `modelPreset` MUST clear the direct `model` in one transaction.
- Writing a direct `model` MUST clear `modelPresetId` in one transaction.
- A provider write incompatible with a referenced preset MUST fail with an
  actionable error before commit.
- `agents set <id> provider <p> --model <m>` MUST validate the pair together,
  write both in one update, and drop a referenced preset in that same update.
- `agents set <id> model clear` MUST clear the direct `model` without
  validating it, and the provider MUST then be settable on its own.
- `agents set ... --model` with any key other than `provider`, or with an empty
  value, MUST be refused as `USAGE_ERROR` (exit 2) before any write, including
  for keys that return early (`description`, `modelPreset`, `groupDebounceMs`).
- `agents set <id> provider <p> --model <m> --force` MUST clear session model
  overrides as well as provider overrides.
- A provider argument MUST be trimmed once, so validation and storage use the
  same value.
- `agents show <id> --json` MUST expose `effectiveProvider`, `effectiveModel`,
  `modelSource`, `modelPresetId`, and `modelPresetVersion`.
- Assigning a missing or disabled preset MUST fail and MUST NOT fall back to the
  global default silently.

## Agent Set Session Override Checks

- `agents set --json` MUST return a typed `sessionOverrides` array on both
  changed and idempotent mutations.
- Every entry MUST use the canonical session name and MUST include only active
  `model`, `effort`, and `thinking` override fields.
- Human output MUST list all active overrides and MUST avoid raw channel ids.
- A mutation with no active session overrides MUST NOT print a warning.

## Agent Defaults Write Checks

- A defaults patch without `runtimePermissions` MUST keep the stored
  `runtimePermissions` and every key it did not name; `null` MUST remove a key.
- A defaults patch that sets, replaces or removes `runtimePermissions` MUST be
  refused with `AGENT_DEFAULTS_PERMISSIONS_READ_ONLY` and write nothing.
- The merge MUST read the row inside the write transaction
  (`dbPatchAgentDefaults`), not a copy read earlier by the caller.
- The `audit_log` actor MUST name the runtime context (`context=`, `agent=`)
  inside a gateway call and `console:<sub>` for a Console invocation.
- `audit_log.old_value.previous` MUST hold only changed/removed keys, with
  secret-looking names redacted at any depth.
- Two writers that build from the same read and grant different capabilities
  MUST both land (deep merge; arrays as sets).
- A capability revoked by a rebased writer MUST be gone even when another
  writer re-wrote the list in the other format (string vs object), and the
  same capability granted in both formats MUST land once.
- The break-glass check of a rebased permission write MUST see the row as
  stored inside the write transaction: a dormant break-glass planted between an
  agent's early check and its write MUST be refused, and the refusal MUST write
  nothing.

## Commands

- `bun test src/cli/commands/agents.test.ts`
- `bun test src/router/router-db.agent-write-audit.test.ts src/router/agent-defaults-patch.test.ts`
- `bun test src/router/router.test.ts`
