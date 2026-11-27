# Context agent-first CLI contract / CHECKS

## Checks

- `context info <unknown-id> --json` MUST exit 1 with the `CONTEXT_NOT_FOUND`
  envelope and up to three `suggestions` built from real context IDs.
- `context lineage <unknown-id> --json` MUST exit 1 with `CONTEXT_NOT_FOUND`.
- `context revoke <id>` MUST revoke immediately because it reduces authority,
  cascading unless `--no-cascade` was passed, and MUST expose no context key.
- `context credentials remove <key>` without `--execute` MUST exit 3 and MUST
  NOT write the store; the plan MUST identify the entry by allowed IDs plus
  path/key/label presence flags, never path, label, full key, or masked key.
- Any error envelope, dry-run plan or suggestion list in this domain MUST NOT
  contain a full `rctx_*` context key — this is the domain's security
  invariant and outranks every convenience concern.
- `context credentials set-default <unknown-key> --json` MUST exit 1 with
  `CREDENTIAL_NOT_FOUND` and id/label suggestions.
- `context prune` MUST keep its `--apply` + `--confirm prune-contexts` brake
  unchanged (no rename to `--execute`), and without `--apply` MUST only plan.
- `context cleanup-agent-runtime` MUST keep dry-run as the default and
  `--revoke` as the explicit execute switch.
- `context list --fields a,b,c --json` and `context credentials list --fields
  a,b,c --json` MUST return items containing only the requested fields.
- The test suite `bun test src/cli/commands/context.test.ts` SHOULD pass after
  any change to this contract surface.
- `bun test src/cli/commands/context-hook-gateway.test.ts` MUST preserve the
  stdin payload through the real CLI registry and host gateway, including the
  deprecated alias. Missing payloads MUST deny without reading daemon stdin;
  invalid credentials, transport failures and malformed gateway output MUST
  produce Codex deny JSON with exit `0`. Audit MUST redact `payload`.

- `bun test src/cli/commands/context-hook-gateway.test.ts` checks original
  permission provider reason, principal and operation survive the hook response
  while credentials remain redacted and denied tools never run.

- `bun test --preload ./src/test/isolated-runtime-preload.ts
  src/cli/registry-operator-credentials.test.ts` MUST exercise an installed
  package fixture with distinct client and daemon stores: missing/empty/list,
  default selection and braked/executed removal remain client-local, without
  opening SQLite. Adding a candidate MUST call authenticated `context whoami`
  and write only the client store, including its first credential. Gateway
  401/403, malformed/inactive replies and unavailability MUST leave stores
  unchanged. Runtime authority, explicit remote configuration and forged
  transport metadata MUST never activate the local operator path.

- `bun test src/cli/command-access.test.ts` MUST deny the local operator to a
  `cli` call carrying `RAVI_AUTOMATION_PRINCIPAL=automation:job:*` or a
  malformed marker, and MUST keep it for `automation:cron:*` and
  `automation:trigger:*`. Removing the job check, dropping trigger from the
  operator-owned set, or treating a malformed marker as operator-owned MUST
  each fail a test.

- `bun test src/omni/workspace-inspection.test.ts` MUST show that the edit
  notice never runs git in the agent workspace: a planted `core.fsmonitor`
  script never runs.

- `bun test src/runtime/agent-instructions.test.ts` MUST show that a symlinked
  `AGENTS.md` or `CLAUDE.md` is never written through, and that a symlinked
  legacy `AGENTS.md` bridge leaves a regular `CLAUDE.md` with its instructions.

- `bun test src/runtime/ravi-rules.test.ts` MUST show that a `.ravi/rules` link
  out of the workspace loads nothing and that an import through a symlinked
  directory is refused before any directory is created outside.

- `bun test src/cli/caller-cwd.test.ts` MUST deny a read outside the session
  workspace and temp to a person held below break-glass.

- `bun test src/automation/shell-workspace-exposure.test.ts
  src/cli/commands/doctor.test.ts` MUST flag a shell cron or trigger whose
  command runs a file under an agent `cwd`, and `ravi doctor` MUST warn with
  `permissions.shell_automation_in_agent_workspace`.

- `bun test src/runtime/codex-provider.test.ts -t "held|sandbox"` MUST show a
  held turn sending `sandboxPolicy: {type: "readOnly"}` on `turn/start`, an
  operator turn after it sending `dangerFullAccess` again, and a thread opened
  (or resumed) by a held turn in `read-only`.

- `bun test src/runtime/runtime-request-context.test.ts -t "marks the runtime env"`
  MUST show `RAVI_TURN_HELD_BELOW_AGENT=1` on a held person's turn, the key
  cleared when the next turn is the owner's, and the key set again for a
  contact narrowed to a governed chat's grants (no break-glass deny there).

- `bun test src/runtime/codex-provider.test.ts -t "held|sandbox"` MUST show the
  thread a held turn opens (or resumes) with `web_search: "disabled"` and
  `tools.view_image: false`, and the next operator thread without them.

- `bun test src/runtime/runtime-request-context.test.ts -t "every executable"`
  MUST show a governed-chat grant for named executables (`ravi`, `ra*`) held
  and only `execute:executable:*` keeping the agent's sandbox.
