---
id: runtime/providers/claude-code
title: "Claude Code Runtime Provider"
kind: feature
domain: runtime
capabilities:
  - providers
  - claude-code
  - host-hooks
  - plugins
  - spec-mode
tags:
  - runtime
  - default-provider
  - hooks
  - mcp
applies_to:
  - src/runtime/*provider.ts
  - src/runtime/host-hooks.ts
  - src/runtime/runtime-host-attachments.ts
  - src/runtime/*provider.test.ts
  - src/runtime/model-catalog.ts
  - src/runtime/model-catalog.test.ts
  - src/tui/components/ModelPicker.tsx
  - src/tui/components/ModelPicker.test.ts
  - src/remote-spawn.ts
  - src/remote-spawn.test.ts
  - src/remote-spawn-nats.ts
  - src/mcp/claude-facade.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Claude Code Runtime Provider

## Intent

The Claude Code provider adapts the current default cloud execution bridge into Ravi's canonical runtime contract. It is the richest existing provider for host hooks, plugins, spec mode, remote spawn, session resume, and session fork.

## Current Shape

- Provider id: current default cloud runtime.
- Execution mode: provider query bridge.
- Session state: native session id in `RuntimeSessionState.params`.
- Resume: supported.
- Fork: supported only for provider-session-level native fork semantics. Arbitrary historical fork/rebase from a Ravi prompt atom requires the canonical `runtime/session-continuity/forks` planner and replay/materializer.
- Partial text: supported through stream delta events.
- Tool hooks: supported through provider-native hook integration.
- Host session hooks: supported.
- Plugins: supported.
- Spec server: supported through MCP attachment.
- Registered MCP servers: native tools `mcp__<server>__<tool>` through
  in-process gateway facades (`mcp`, Claude Facade). Servers from `.mcp.json`,
  plugins, user or managed settings and claude.ai connectors do not load.
- Remote spawn: supported.
- Dynamic tools through Ravi host services: not supported in the same path as Codex.
- Runtime control operations: no provider-native `control()` handle today.
- Live model switch: supported through `setModel` on active query when available, with fallback to next turn.

## Event Mapping

- Stream text delta -> `text.delta`
- Status system event -> `status`
- Assistant text block -> `assistant.message`
- Assistant tool-use block -> `tool.started`
- User tool-result block -> `tool.completed`
- Successful result -> `turn.complete`
- Non-success result -> `turn.failed`
- Query exception -> recoverable `turn.failed`
- Stream end without a terminal result -> recoverable `turn.failed` (desired contract; current code must be audited when this path is changed)

## Skill Visibility

- Claude Code supports Ravi plugins during provider bootstrap, but plugin availability MUST NOT be interpreted as skill loaded state.
- Claude skill visibility MUST distinguish:
  - `available`/`advertised`: plugin or skill data was passed to the native query bridge.
  - `requested`: a Skill tool or equivalent provider mechanism was requested.
  - `loaded`: the adapter observed a provider-native Skill load/invocation signal or Ravi completed explicit skill injection.
- The adapter MAY derive `loaded` from a provider tool-use event only after the Skill event shape is verified and normalized. Until then, Claude sessions MUST keep `loadedSkills` conservative.
- Skill evidence SHOULD retain the raw provider event type, tool-use id, and canonical skill name so session visibility can explain why a skill appears as loaded.

## Invariants

- The provider MUST pass Ravi `systemPromptAppend` as additional system instructions.
- The provider MUST pass Ravi-owned env into the native query environment.
- The provider MUST snapshot the current Ravi-owned env immediately before each
  native query. A live provider session MUST observe the newly rotated
  `RAVI_CONTEXT_KEY` and removal of stale managed `RAVI_*` values on the next
  turn without resetting conversation history.
- The provider MUST pass Ravi `canUseTool`. Claude Code consults it only when
  it asks for a permission, so it is not the tool gate.
- Sessions run with `bypassPermissions`, where Claude Code auto-allows tool
  calls without asking `canUseTool`: the PreToolUse hook chain is the tool
  gate. It MUST check every tool call by name, including `mcp__*` tools of
  servers Claude Code loaded from its own configuration or plugins
  (`permissions/provider-runtime`, Runtime Tool Calls).
- The PreToolUse hooks that ask a person (`mcp__spec__exit_spec_mode`,
  `ExitPlanMode`, `AskUserQuestion`) MUST fail closed: Claude Code runs a tool
  whose PreToolUse hook throws, so any error inside them (the approval or poll
  request, the approval event, a crash recovery marker) MUST become a deny with
  a fixed reason, and the error is logged, never put in the reason. A lost
  attempt keeps its ownership-change denial. An approved, declined or
  timed-out answer is handled as before.
- The provider MUST start Claude Code with `@path` mentions off
  (`permissions/provider-runtime`, Prompt Text).
- The provider MUST load registered MCP servers only (`mcp`):
  - `Options.strictMcpConfig: true`, `skipMcpDiscovery: true` on every plugin
    entry, and `settings.disableClaudeAiConnectors: true`, on every query;
  - `Options.mcpServers` holds exactly the host servers plus the gateway
    facades built for the turn, merged here and nowhere else; the two name
    sets MUST be disjoint;
  - only the host names go to the hook as `hostMcpServers`; only the facade
    names go to it as `gatewayMcpServers`;
  - the hook applies the provenance rule of `permissions/provider-runtime`
    (Runtime Tool Calls): a tool reported from any source other than `sdk`
    plus a declared name is denied, `use:tool:*` included;
  - the `system/init` message's `mcp_servers` list MUST be compared with the
    names of the query's final `Options.mcpServers` (host plus facade names).
    Every declared server is in-process, so an entry under a declared name
    from a source other than `sdk` is extra too; an entry without `source`
    (a Claude Code older than the field) is compared by name. An extra entry
    MUST fail the turn, not recoverable, with an error that names the server
    and the source as quoted untrusted text, and MUST close the query, so the
    turn does not run with that server attached. The turn failure is traced
    with the server list. A missing entry does not fail the turn and is
    logged; an init message without a server list is not compared (the hook
    rule still applies).
  - the three settings are set after the caller's permission options, so no
    option a caller passes can turn them off; a caller's inline `settings`
    object is kept, with `disableClaudeAiConnectors` forced to `true`.
- `--strict-mcp-config` MUST survive the SSH and NATS remote-spawn argument
  filters. A worker host that loads its own settings is still covered by the
  hook rule and the init check.
- Gateway facades are built per turn from the cached catalog with no network
  call. A facade tool call runs `authorizeMcpUse` again and forwards under an
  inline budget of 240 seconds, below the five-minute tool watchdog.
- The tool watchdog MUST ignore a declared `timeout` argument for `mcp__`
  names that are not host tools, so a remote tool cannot extend its own
  inactivity window.
- The runtime trace MUST list host and gateway servers with kind, transport,
  era, tool count and status, and the server list Claude Code reported.
- The provider MUST register the spec server under the name the tool gate
  declares as a host server (`SPEC_MCP_SERVER_NAME`).
- The provider MUST attach host hooks only when capabilities allow it.
- The provider MUST attach spec server only for spec-mode agents.
- The provider MUST attach remote spawn only for remote agents.
- SSH remote spawn MUST preserve the selected auth values, `RAVI_CONTEXT_KEY`
  and `RAVI_GATEWAY_URL` byte-for-byte, including quotes, backslashes, literal
  `\\n` sequences and other shell metacharacters.
- SSH remote spawn MUST NOT put any forwarded value in the ssh argv (visible in
  local `ps` and as the remote shell's command line). The remote command names
  only the keys (`IFS= read -r KEY && export KEY && ...`); the values are written
  to the ssh stdin, one per line, before any SDK input. A value containing a
  newline cannot be framed this way and MUST be refused, never truncated.
- SSH remote spawn MUST forward `RAVI_GATEWAY_URL` when configured. For loopback
  SSH agents only, it MAY derive that URL from the enabled daemon HTTP listener
  (`RAVI_HTTP_PORT`, or its webhook alias). It MUST NOT infer that a different
  host can reach the daemon through loopback or forward unrelated host secrets.
  Derivation MUST use the listener's port precedence (an explicitly empty HTTP
  port disables the listener) and trimmed HTTP/webhook host selection.
- A successful result MUST produce `turn.complete` with session id and usage.
- A non-success result MUST produce `turn.failed`.
- A query exception MUST become recoverable `turn.failed`, not an unhandled event-loop error.
- A provider stream that ends without a terminal result MUST become recoverable `turn.failed`.
- `setModel` MUST update current and subsequent turns; if native live switch fails, the next query MUST still use the requested model.
- Claude native `forkSession` MUST NOT be treated as arbitrary prompt-history fork unless the SDK exposes a tested cursor that maps to Ravi prompt atoms.

## Model Compatibility

- SSH and NATS remote spawn MUST remove local-only `--plugin-dir`,
  `--plugin-dir-no-mcp`, and `--setting-sources` options in both `--flag value`
  and `--flag=value` encodings. Removing an equals-form option MUST NOT consume
  the following argument; model, effort, and output options MUST be preserved.
- The bundled SDK MUST support the model ids advertised by the runtime catalog.
  Fable support includes `claude-fable-5`, `claude-fable-5-1`, and
  `claude-fable-5-2`. Model normalization MUST preserve the requested name
  (apart from surrounding whitespace), including `fable`, `claude-mythos-5`,
  explicit versions, and unknown ids. Alias resolution and fallback belong to
  the provider; Ravi MUST NOT translate names by family substrings or pin an
  alias to a catalog version. Mythos is a distinct model, not a Fable alias.
- Preferred model resolution MUST NOT use the display catalog as an allowlist.
  A nonempty name MUST pass through; only an absent or blank name selects the
  provider default. Existing handling of incompatible runtimes remains.
- The model picker MUST retain a configured compatible id missing from its
  display catalog as a visible selected option. Confirming without choosing
  another model MUST preserve that id; choosing a listed alternative MUST
  apply the newly selected id. The current option MUST NOT alter the shared
  catalog or leak into another provider's choices.
- The Fable family (the `fable` alias and names beginning with `fable-` or
  `claude-fable-`, including future versions) and `claude-mythos-5` MUST NOT
  receive `thinking: { type:
  "disabled" }` when Ravi requests `thinking=off`. The provider MUST omit that
  override, preserve adaptive thinking with display `omitted` for `normal`, and
  preserve adaptive thinking with display `summarized` for `verbose`.
- Adding an advertised model or upgrading its SDK support MUST include a real
  Ravi session round-trip with the explicit provider and model. Compilation and
  mocked provider tests alone MUST NOT be recorded as live acceptance.

## Validation

- `bun test src/runtime/*provider.test.ts`
- `bun test src/runtime/provider-contract.test.ts`
- `bun test src/runtime/host-env.test.ts`
- `bun test src/runtime/runtime-host-attachments.test.ts`
- `bun test src/runtime/session-trace.test.ts`
- `bun test src/remote-spawn.test.ts`

## Known Failure Modes

- Provider-native tool result is missing or malformed, leaving Ravi with `tool.start` and no `tool.end`.
- Query throws after an interrupt and Ravi misclassifies it as a user-facing failure.
- Provider emits text/tool events but no terminal result, leaving the turn active until the adapter converts stream end into `turn.failed`.
- Host exit-plan logic still reads a provider-specific plan directory; future providers need an explicit plan artifact/control contract instead of host hardcoding.
- Provider-specific settings files are created during prepare but not captured as explicit runtime bootstrap state.
- Host hooks are available here but not in Codex, which can hide permission behavior differences.
- A Claude Code version, managed setting or connector that loads a server
  despite the strict flags makes every turn fail on the init check until the
  server is removed or registered.
- A host with an enterprise MCP configuration (`managed-mcp.json`) cannot run
  Ravi's Claude sessions: Claude Code 2.1.323 refuses to start with
  `--strict-mcp-config` while that file exists ("You cannot use
  --strict-mcp-config when an enterprise MCP config is present"), so every
  query fails before the model runs. This fails closed by design.
- A facade name placed in `hostMcpServers` exempts every remote tool from the
  name check.
- Regressing to a native query environment copied only at provider-session
  start freezes turn-scoped authority. Grants and revocations then remain stale
  until the provider session or daemon restarts.
- Runtime controls are unavailable even though the sessions CLI exposes a generic control surface.
- Raw events lack consistent thread/turn/item metadata compared with Codex, reducing trace correlation.
- The model catalog is alias-based and provider-specific instead of a generic provider model registry.
- Skill loading is not yet normalized as a first-class provider event; passing plugins to Claude only proves availability/advertisement.
