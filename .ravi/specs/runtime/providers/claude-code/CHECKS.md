# Claude Code Provider Checks

## Required Tests

- SSH and NATS spawn factories strip both SDK encodings of local plugin paths
  and setting sources, preserving following model/effort/output arguments;
  verify with `bun test src/remote-spawn.test.ts src/remote-spawn-nats.test.ts`.
- The PreToolUse chain is the tool gate under `bypassPermissions`: every tool
  name is checked, `mcp__*` tools of configured servers included, and only the
  in-process servers the session registers are exempt. The regressions are
  listed in `permissions/provider-runtime` CHECKS (Runtime tool call
  regressions); verify with
  `bun test src/bash/hook.test.ts src/runtime/host-hooks.test.ts`.
- Approval hooks fail closed (`src/runtime/host-hooks.test.ts`, "approval
  hooks fail closed"): a throwing `requestCascadingApproval` denies
  `mcp__spec__exit_spec_mode` and `ExitPlanMode`, a throwing
  `requestPollAnswer` or approval event denies `AskUserQuestion`, a failing
  crash recovery marker denies instead of throwing, the reason names no error
  text, and a declined plan or a timed-out poll keep their old answers.
- The spec server is registered under `SPEC_MCP_SERVER_NAME`, the same key the
  tool gate exempts; `src/runtime/host-hooks.test.ts` builds a session and
  compares the two.
- Registered-only loading (`src/runtime/claude-provider.test.ts`): every query
  carries `strictMcpConfig: true`, `skipMcpDiscovery: true` on each plugin and
  `settings.disableClaudeAiConnectors: true`, and caller permission options
  cannot turn them off; an init message listing a server outside the declared
  names, or a declared name from a source other than `sdk`, fails the turn
  (not recoverable) with the server and source named, and closes the query; a
  result after it does not complete the turn; a missing declared server and an
  init without a server list do not fail. A name shared by the host and
  gateway lists throws when the hook is built (`src/bash/hook.test.ts`).
- `bun test src/remote-spawn.test.ts src/remote-spawn-nats.test.ts`: both
  argument filters keep `--strict-mcp-config` and the `--settings` value that
  carries `disableClaudeAiConnectors`, in the form Agent SDK 0.3.323 builds.
- Facades (`src/mcp/claude-facade.test.ts`): tool names are exactly
  `mcp__<server>__<tool>`; facade names reach the hook only as
  `gatewayMcpServers`; a declared `timeout` argument does not extend the
  watchdog for a facade tool; the trace row lists host and gateway servers.
- Live check before relying on it (`mcp` RUNBOOK): the strict flags leave
  `system/init.mcp_servers` equal to the declared set, and a facade tool call
  reports `source: "sdk"` locally and on remote spawn. The first half was run
  on Claude Code 2.1.323 on 2026-11-25 (RUNBOOK, recorded result).
- Every Claude Code process starts with `CLAUDE_CODE_DISABLE_FILE_MENTIONS=1`,
  over a caller value of `0`: session turns on every path of
  `buildClaudeCodeEnvironment`, the memory agent (the value the spawned
  process received, not only the name), and SSH and NATS remote spawns. The
  regressions are listed in `permissions/provider-runtime` CHECKS (Prompt text
  regressions); verify with
  `bun test src/runtime/claude-provider.test.ts src/remote-spawn.test.ts src/remote-spawn-nats.test.ts`
  and `bun test src/hooks/pre-compact-spawn-env.test.ts`.
- Stream delta maps to `text.delta`.
- Assistant text maps to `assistant.message`.
- Assistant tool-use maps to `tool.started`.
- User tool-result maps to `tool.completed`.
- Success result maps to `turn.complete` with session state and usage.
- Non-success result maps to recoverable `turn.failed`.
- Query exception maps to recoverable `turn.failed`.
- `setModel` updates active query when possible and always affects next query.
- A live provider session snapshots the current Ravi env for every query: a
  rotated `RAVI_CONTEXT_KEY` appears on the next turn, removed managed values do
  not survive, and the Claude session id is still resumed.
- Resume session id is read from `RuntimeSessionState.params`.
- Fork is passed only when requested by session continuity.
- A real POSIX shell preserves a single auth token and multiple forwarded auth,
  context and gateway values read from stdin, including shell metacharacters,
  backslashes and literal `\\n` sequences; a value with a real newline is
  refused, and no forwarded value appears in the ssh argv or the ssh child env.
- A loopback SSH agent receives the enabled daemon HTTP gateway URL; an
  unrelated remote host does not receive an inferred loopback URL.
- An explicit gateway URL takes precedence, invalid HTTP ports do not create a
  URL, and unrelated secrets never enter the forwarded environment.
- Gateway derivation follows the listener's configuration precedence: an
  explicitly empty HTTP port disables fallback to the webhook port, and HTTP
  and webhook host values are trimmed before selecting the IPv6 loopback URL.

## Model Compatibility Acceptance

- `bun test src/runtime/claude-provider.test.ts src/runtime/model-catalog.test.ts`
  covers unchanged selectors for `fable`, `claude-mythos-5`, and
  `claude-fable-5-2`, as well as unknown ids, future versions and names that
  contain `sonnet`, `opus` or `haiku`. Surrounding whitespace is trimmed.
- Missing and blank names select the provider default; unknown ids pass through
  even when a local display catalog exists. Incompatible-runtime cases retain
  their existing fallback and validation behavior.
- `bun test src/tui/components/ModelPicker.test.ts` renders the actual picker
  with configured ids outside its display catalog, verifies the selected id
  and next-runtime preview, then confirms unchanged or selects a different
  catalog row. Missing/blank models retain the default behavior.
- The same tests cover the `off`/`normal`/`verbose` adaptive thinking contract
  for Fable 5, 5-1, 5-2, future versions, the short `fable` alias, and Mythos.
  Sonnet and lookalikes such as `claude-fableish-5` and `my-fable-model` still
  receive disabled thinking for `off`.
- With the updated installed SDK, create a Ravi session using
  `--provider claude --model claude-fable-5-2`, send a unique response marker,
  and verify the returned text plus the session's successful terminal turn.
  Record the SDK version and tested commit in the PR; unit tests are not this
  real-session acceptance proof.

## Regression Cases

- Native interruption throws an abort-like error after Ravi requested interrupt.
- Provider emits partial text but no assistant message.
- Provider emits assistant message before a tool result.
- Provider emits result with missing usage.
- Hooks are missing for an agent that requires restricted tool access.
- Plugin attachment exists but provider capabilities are false.
- Spec server attachment exists for non-spec agents.
